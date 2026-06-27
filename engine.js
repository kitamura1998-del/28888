/* ============================================================
   2と8 — Rule Engine (PURE: no DOM, no audio, no timers)
   Works in the browser (as window-global Engine) and in Node.
   State is plain JSON. apply(state, action) -> {state, events}.
   Supports 3-5 players, 4 or 5 deal size, optional ロン返し,
   and 流局 (round void) when the deck runs out twice.
   ============================================================ */
var Engine = (function(){
  "use strict";
  var SUITS = ["\u2660","\u2665","\u2666","\u2663"]; // ♠ ♥ ♦ ♣
  var RED   = {"\u2665":1,"\u2666":1};
  var HAND_SIZE = 5;

  function buildDeck(){ var d=[]; for(var s=0;s<4;s++) for(var r=1;r<=13;r++) d.push({suit:SUITS[s],rank:r}); return d; }
  function shuffle(a,rng){ rng=rng||Math.random; for(var i=a.length-1;i>0;i--){ var j=Math.floor(rng()*(i+1)); var t=a[i];a[i]=a[j];a[j]=t; } return a; }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function nextSeat(i,n){ n=n||4; return (i+1)%n; }
  function handSum(p){ return p.hand.reduce(function(t,c){return t+c.rank;},0); }
  function top(s){ return s.discard[s.discard.length-1]; }
  function matches(s,c){ if(s.rainbow) return true; return c.suit===s.suit || c.rank===s.rank; }

  function newMatch(prevScores, cfg){
    cfg = cfg||{};
    var N = Math.max(3, Math.min(5, cfg.players||4));
    var deal = (cfg.deal===4||cfg.deal===5)?cfg.deal:HAND_SIZE;
    var rr = !!cfg.ronReturn;
    var players=[]; for(var i=0;i<N;i++) players.push({hand:[], score:(prevScores&&prevScores[i]!=null)?prevScores[i]:0, calledOne:false});
    return {
      players:players,
      deck:[], discard:[], suit:null, rank:null,
      turn:0, phase:"idle",
      starter:null, comboMult:1, tenpoMult:1, ronTarget:null, ronReturnTarget:null,
      suitChooser:null, ron:null, ronRet:null, result:null, lastWinner:null, starterPenalty:false, rainbow:false,
      dealSize:deal, ronReturn:rr, roundStart:0, deckRecycles:0, voidPending:false
    };
  }

  function startRound(state, startSeat, rng){
    var s = clone(state);
    var n = s.players.length;
    s.deck = shuffle(buildDeck(), rng);
    s.discard = []; s.players.forEach(function(p){ p.hand=[]; p.calledOne=false; });
    var deal = s.dealSize||HAND_SIZE;
    for(var k=0;k<deal;k++) for(var p=0;p<n;p++) s.players[p].hand.push(s.deck.pop());
    var starter = s.deck.pop();
    s.discard=[starter]; s.suit=starter.suit; s.rank=starter.rank; s.starter=starter;
    s.comboMult=1; s.tenpoMult=1; s.ronTarget=null; s.ronReturnTarget=null; s.suitChooser=null;
    s.ron=null; s.ronRet=null; s.result=null; s.rainbow=false;
    s.deckRecycles=0; s.voidPending=false; s.roundStart=startSeat; s.deckLastDone=false; s._enteredLastDeck=false;
    s.starterPenalty = (starter.rank===2);   // starter is a 2 -> first player who must draw eats 2
    s.turn=startSeat; s.phase="turn";
    var events=[];
    var sm=starterMult(s);
    if(sm>1) events.push({t:"starterIntro", mult:sm, card:starter});
    // 天保 (tenpo): a player's opening hand SUM equals the starter rank -> instant win, +×5
    var tenpoWinner=-1;
    for(var step=0; step<n; step++){ var i=(startSeat+step)%n; if(handSum(s.players[i])===starter.rank){ tenpoWinner=i; break; } }
    if(tenpoWinner>=0){
      s.tenpoMult=5;
      events.push({t:"tenpo", seat:tenpoWinner, mult:starterMult(s)*5});
      scoreRound(s, tenpoWinner);
      events.push({t:"roundOver"});
    }
    return {state:s, events:events};
  }

  function drawCard(s){
    if(s.deck.length===0){
      if(s.discard.length<=1) return null;             // truly nothing left
      s.deckRecycles=(s.deckRecycles||0)+1;
      if(s.deckRecycles>=3){ s.voidPending=true; return null; }   // deck ran out a 3rd time -> 流局
      var keep=s.discard.pop(); s.deck=shuffle(s.discard); s.discard=[keep];
      if(s.deckRecycles===2) s._enteredLastDeck=true;             // now on the final (3rd) deck
    }
    return s.deck.pop();
  }
  function give(s,seat,n,events){
    var added=0;
    for(var k=0;k<n;k++){ var c=drawCard(s); if(!c) break; s.players[seat].hand.push(c); events.push({t:"draw",seat:seat,card:c}); added++; }
    if(added>0) s.players[seat].calledOne=false;   // hand grew -> must call again if back to 1
    if(s._enteredLastDeck && !s.deckLastDone){ s.deckLastDone=true; s._enteredLastDeck=false; events.push({t:"deckLast"}); }  // warn everyone
  }
  function setField(s,c,seat,events){ s.discard.push(c); s.suit=c.suit; s.rank=c.rank; events.push({t:"place",seat:seat,card:c}); }

  // fun call-outs when a card is played
  var SINGLE_COMMENT={1:"いっぺー",3:"さんぺいです",4:"よんちゃん",5:"ゴム",6:"むーみん",7:"なに〜",8:"いろがえ〜",10:"おてん！",11:"ジェジェジェイ",13:"行ける時〜"};
  var TWO_COMMENT={3:"積み立てにーさ！",4:"西。",5:"にーご！",6:"にーむ！",7:"にーな！",10:"にってん！",11:"にーじぇ！",12:"二フィーフィー！",13:"2とでっかいところ！"};
  function playComment(opts){
    // opts: {type:"normal"|"two", rank, count, kabu}
    if(opts.type==="two"){
      if(opts.rank===8) return null;                 // 2+8 is the special combo splash
      if(opts.rank===9) return (opts.count>=2)?"ニンニク！":"おにく！";
      return TWO_COMMENT[opts.rank]||null;
    }
    if(opts.kabu) return "かっぶ。";                  // played a card of the same number as the field
    return SINGLE_COMMENT[opts.rank]||null;
  }

  function starterMult(s){
    var c=s.starter; if(!c) return 1;
    if(c.rank===10||c.rank===11||c.rank===12) return 2;
    if(c.rank===13) return 3;
    if(c.rank===1 && c.suit==="\u2660") return 5;
    return 1;
  }

  // membership-aware validation; cards are plain {suit,rank} values
  function validatePlay(s, seat, cards){
    if(!cards || cards.length===0) return {ok:false};
    var hand=s.players[seat].hand.slice();
    for(var i=0;i<cards.length;i++){
      var f=-1;
      for(var j=0;j<hand.length;j++){ if(hand[j].suit===cards[i].suit && hand[j].rank===cards[i].rank){ f=j; break; } }
      if(f<0) return {ok:false,msg:"\u305d\u306e\u672d\u306f\u624b\u672d\u306b\u3042\u308a\u307e\u305b\u3093"};
      hand.splice(f,1);
    }
    var twos=cards.filter(function(c){return c.rank===2;});
    var others=cards.filter(function(c){return c.rank!==2;});
    if(twos.length===0){
      if(cards.length!==1) return {ok:false,msg:"\u8907\u6570\u679a\u306f2\u306e\u3068\u304d\u3060\u3051\u51fa\u305b\u307e\u3059"};
      if(!matches(s,cards[0])) return {ok:false,msg:"\u5834\u306e\u30de\u30fc\u30af\u304b\u6570\u5b57\u306b\u5408\u3063\u3066\u3044\u307e\u305b\u3093"};
      return {ok:true,type:"normal",card:cards[0]};
    }
    if(others.length>1) return {ok:false,msg:"\u305d\u3048\u3089\u308c\u308b\u30ab\u30fc\u30c9\u306f1\u679a\u307e\u3067\u3067\u3059"};
    if(!twos.some(function(c){return matches(s,c);})) return {ok:false,msg:"\u5834\u306b\u5408\u30462\u304c\u3042\u308a\u307e\u305b\u3093"};
    var follow=null;
    if(others.length===1){
      follow=others[0];
      var sm={}; twos.forEach(function(c){ sm[c.suit]=1; });
      if(!sm[follow.suit]) return {ok:false,msg:"\u305d\u3048\u308b\u672d\u306f2\u3068\u540c\u3058\u30de\u30fc\u30af\u306b\u3057\u3066\u304f\u3060\u3055\u3044"};
    }
    return {ok:true,type:"two",twos:twos,follow:follow};
  }

  function removeCards(p, cards){
    cards.forEach(function(c){
      for(var i=0;i<p.hand.length;i++){ if(p.hand[i].suit===c.suit && p.hand[i].rank===c.rank){ p.hand.splice(i,1); break; } }
    });
    p.calledOne=false;   // hand changed -> if now 1 card, must call "ワン" again
  }

  function ronCandidate(s, placer, byRank){
    var n=s.players.length;
    for(var step=1; step<=n-1; step++){ var i=(placer+step)%n; if(handSum(s.players[i])===byRank) return i; }
    return -1;
  }

  // scoring value of a hand, in integer tenths: 10/J/Q/K = 10 tenths (=1.0), rank n(<=9) = n tenths (=0.n)
  function handTenths(p){ var t=0; p.hand.forEach(function(c){ t += (c.rank>=10 ? 10 : c.rank); }); return t; }
  function scorePoints(p){ var t=handTenths(p); return Math.floor((t + 9) / 10); }   // ceil(tenths/10): round the decimal sum up

  function scoreRound(s, winner){
    var n=s.players.length;
    var sM=starterMult(s), cM=s.comboMult||1, tM=s.tenpoMult||1, base=sM*cM*tM;
    var rows=[], pot=0;
    for(var i=0;i<n;i++){
      if(i===winner){ rows.push({seat:i,sum:0,raw:0,mult:1,win:true,delta:0}); continue; }
      var pts=scorePoints(s.players[i]);        // rounded-up hand value
      var raw=handTenths(s.players[i])/10;      // exact decimal sum (for display)
      var extra=(i===s.ronReturnTarget)?4:(i===s.ronTarget)?2:1;   // ロン返しは×4, ロンは×2
      var mult=base*extra, loss=pts*mult;
      pot+=loss; s.players[i].score-=loss;
      rows.push({seat:i,sum:pts,raw:raw,mult:mult,ron:extra>1,ronReturn:(i===s.ronReturnTarget),win:false,delta:-loss});
    }
    s.players[winner].score+=pot;
    rows.forEach(function(r){ if(r.win) r.delta=pot; });
    var hands=[]; for(var hi=0;hi<n;hi++){ hands.push(s.players[hi].hand.map(function(c){return {suit:c.suit,rank:c.rank};})); }
    s.result={winner:winner,rows:rows,starterMult:sM,comboMult:cM,tenpoMult:tM,starter:s.starter,
              ronTarget:s.ronTarget,ronReturnTarget:s.ronReturnTarget,pot:pot,hands:hands};
    s.lastWinner=winner; s.phase="roundover";
  }

  function advance(s, events){
    s.turn=nextSeat(s.turn, s.players.length); s.phase="turn";
    // ワンペナルティ: if the player starting their turn still has 1 card and never called "ワン", they draw 2
    var pl=s.players[s.turn];
    if(pl.hand.length===1 && !pl.calledOne && events){
      events.push({t:"onePenalty", seat:s.turn});
      give(s, s.turn, 2, events);
    }
  }

  function contNormal(s, placer, card, events){
    if(s.players[placer].hand.length===0){ scoreRound(s,placer); events.push({t:"roundOver"}); return; }
    if(card.rank===8){ s.phase="suit"; s.suitChooser=placer; events.push({t:"needSuit",seat:placer}); return; }
    advance(s, events);
  }
  function contTwoFollow(s, placer, follow, count, events){
    var isCombo=(follow.rank===8);
    if(isCombo){ s.comboMult*=2; events.push({t:"combo",mult:starterMult(s)*s.comboMult,seat:placer}); }
    if(s.players[placer].hand.length===0){ scoreRound(s,placer); events.push({t:"roundOver"}); return; }
    if(isCombo){ s.phase="suit"; s.suitChooser=placer; events.push({t:"needSuit",seat:placer}); return; }
    advance(s, events);
  }
  function contTwoNoFollow(s, placer, count, events){ advance(s, events); }

  function afterTwoRon(s, placer, follow, count, events){
    // the 2 was not ron'd: now apply the 2-penalty draws to everyone else, then resolve the follow card
    var n=s.players.length;
    var sd=nextSeat(placer, n);
    for(var st=0; st<n-1; st++){ give(s, sd, 2*count, events); sd=nextSeat(sd, n); }
    if(follow){
      var ctxF={kind:"twoFollow", placer:placer, follow:follow, count:count};
      // everyone just drew their 2-penalty cards above, so any RON found here is a "引きロン" (drawn into it)
      if(!checkRonOr(s, placer, follow.rank, ctxF, events, true)) contTwoFollow(s, placer, follow, count, events);
    } else {
      // 2 with no follow: if the placer just played their LAST card(s) and went out,
      // they WIN — no 1-card no-follow penalty. (Others already drew their 2-penalty above.)
      if(s.players[placer].hand.length===0){
        scoreRound(s, placer);
        events.push({t:"roundOver"});
        return;
      }
      events.push({t:"penaltyDraw", seat:placer});
      give(s, placer, 1, events);
      contTwoNoFollow(s, placer, count, events);
    }
  }

  function runCont(s, ctx, events){
    if(ctx.kind==="normal") contNormal(s, ctx.placer, ctx.card, events);
    else if(ctx.kind==="afterTwoRon") afterTwoRon(s, ctx.placer, ctx.follow, ctx.count, events);
    else if(ctx.kind==="twoFollow") contTwoFollow(s, ctx.placer, ctx.follow, ctx.count, events);
    else if(ctx.kind==="twoNoFollow") contTwoNoFollow(s, ctx.placer, ctx.count, events);
  }

  function checkRonOr(s, placer, byRank, ctx, events, drawTriggered){
    var cand=ronCandidate(s, placer, byRank);
    if(cand>=0){
      s.phase="ron"; s.ron={candidate:cand, byRank:byRank, placer:placer, ctx:ctx, drawTriggered:!!drawTriggered};
      events.push({t:"ronAvailable", seat:cand, byRank:byRank, placer:placer, drawTriggered:!!drawTriggered});
      return true;
    }
    return false;
  }

  // shared ron resolution: 2 uninvolved players pass their highest card to the ron'd placer, then score
  function resolveRon(s, ronner, placer, events){
    s.ronTarget=placer;
    for(var gi=0; gi<s.players.length; gi++){
      if(gi===ronner || gi===placer) continue;
      var gp=s.players[gi]; if(!gp.hand.length) continue;
      var hiIdx=0; for(var hk=1; hk<gp.hand.length; hk++){ if(gp.hand[hk].rank>gp.hand[hiIdx].rank) hiIdx=hk; }
      var gift=gp.hand.splice(hiIdx,1)[0];
      s.players[placer].hand.push(gift);
      events.push({t:"ronGift", from:gi, to:placer, card:gift});
    }
    scoreRound(s, ronner);   // score AFTER the transfer (ron'd hand bigger, givers smaller)
    events.push({t:"roundOver"});
  }

  function apply(state, action){
    var s=clone(state); var events=[];
    var res=_apply(s, action, events);
    if(res && res.error) return {state:state, events:[], error:res.error};
    // 流局: if the deck ran out a 2nd time during this action, void the round
    if(s.voidPending && s.phase!=="roundover"){
      s.result={winner:-1, voided:true, rows:[], starterMult:1, comboMult:1, tenpoMult:1,
                starter:s.starter, ronTarget:null, ronReturnTarget:null, pot:0, hands:[]};
      s.lastWinner=s.roundStart;   // next round starts from the same player who started this voided round
      s.phase="roundover";
      events.push({t:"roundVoid"});
    }
    return {state:s, events:events};
  }

  // does the work; mutates s/events; returns {error} on failure, undefined on success
  function _apply(s, action, events){
    if(action.type==="play"){
      if(s.phase!=="turn") return {error:"not your turn"};
      var seat=s.turn, p=s.players[seat];
      s.starterPenalty=false;
      var v=validatePlay(s, seat, action.cards);
      if(!v.ok){ events.push({t:"invalid",msg:v.msg}); return {error:v.msg||"invalid"}; }
      removeCards(p, action.cards);
      s.rainbow=false;   // a free "rainbow" turn is consumed once a card is played
      if(v.type==="normal"){
        var prevRank=s.rank;                                   // field number before placing (for かっぶ)
        setField(s, v.card, seat, events);
        var cmtN=playComment({type:"normal", rank:v.card.rank, kabu:(v.card.rank===prevRank)});
        if(cmtN) events.push({t:"comment", seat:seat, text:cmtN});
        var ctxN={kind:"normal", placer:seat, card:v.card};
        if(!checkRonOr(s, seat, v.card.rank, ctxN, events)) contNormal(s, seat, v.card, events);
      } else {
        var count=v.twos.length;
        v.twos.forEach(function(c){ setField(s,c,seat,events); });
        if(v.follow){ setField(s, v.follow, seat, events); }   // lay both cards now so a RON on the 2 can't drop the follow
        events.push({t:"twoEffect", seat:seat, count:count});
        if(v.follow){ var cmtT=playComment({type:"two", rank:v.follow.rank, count:count}); if(cmtT) events.push({t:"comment", seat:seat, text:cmtT}); }
        // RON on the 2 is offered BEFORE anyone draws the 2-penalty.
        var ctx2={kind:"afterTwoRon", placer:seat, follow:(v.follow||null), count:count};
        if(!checkRonOr(s, seat, 2, ctx2, events)) afterTwoRon(s, seat, (v.follow||null), count, events);
      }
      return;
    }
    if(action.type==="draw"){
      if(s.phase!=="turn") return {error:"not your turn"};
      var pen = s.starterPenalty; s.starterPenalty=false;
      if(pen){ events.push({t:"starter2", seat:s.turn}); give(s, s.turn, 2, events); }
      else { events.push({t:"turnDraw", seat:s.turn}); give(s, s.turn, 1, events); }
      advance(s, events);
      return;
    }
    if(action.type==="chooseSuit"){
      if(s.phase!=="suit") return {error:"no suit pending"};
      if(action.suit==="rainbow"){
        s.rainbow=true;
        events.push({t:"rainbow", seat:s.suitChooser});
      } else {
        s.suit=action.suit;
        events.push({t:"suitChosen", seat:s.suitChooser, suit:action.suit});
      }
      s.suitChooser=null; advance(s, events);
      return;
    }
    if(action.type==="ron"){
      if(s.phase!=="ron") return {error:"no ron pending"};
      var r=s.ron;
      events.push({t:"ron", seat:r.candidate, byRank:r.byRank, placer:r.placer, call:(action.call||"\u30ed\u30f3"), drawTriggered:!!r.drawTriggered});
      // ロン返し: if enabled and the placer's OWN hand also sums to byRank, the placer may counter
      if(s.ronReturn && handSum(s.players[r.placer])===r.byRank){
        s.phase="ronReturn";
        s.ronRet={returner:r.placer, ronner:r.candidate, byRank:r.byRank};
        events.push({t:"ronReturnAvailable", seat:r.placer, ronner:r.candidate, byRank:r.byRank});
        s.ron=null;
        return;
      }
      resolveRon(s, r.candidate, r.placer, events);
      s.ron=null;
      return;
    }
    if(action.type==="ronReturn"){
      if(s.phase!=="ronReturn") return {error:"no ronReturn pending"};
      var rr=s.ronRet;
      s.ronReturnTarget=rr.ronner;   // the would-be ronner now loses ×4
      events.push({t:"ronReturn", seat:rr.returner, target:rr.ronner, byRank:rr.byRank, call:(action.call||"\u30ed\u30f3\u8fd4\u3057")});
      scoreRound(s, rr.returner);    // the placer wins (no card-pass on ron-return)
      events.push({t:"roundOver"});
      s.ronRet=null; s.ron=null;
      return;
    }
    if(action.type==="ronReturnPass"){
      if(s.phase!=="ronReturn") return {error:"no ronReturn pending"};
      var rr2=s.ronRet; s.ronRet=null; s.ron=null;
      events.push({t:"ronReturnPass", seat:rr2.returner});
      resolveRon(s, rr2.ronner, rr2.returner, events);   // fall back to a normal ron (ronner wins, placer ron'd ×2)
      return;
    }
    if(action.type==="pass"){
      if(s.phase!=="ron") return {error:"no ron pending"};
      var ctx=s.ron.ctx; s.ron=null; s.phase="idle";
      events.push({t:"ronPass"});
      runCont(s, ctx, events);
      return;
    }
    if(action.type==="callOne"){
      var cs=action.seat;
      if(cs==null||cs<0||cs>=s.players.length) return {error:"bad seat"};
      var cp=s.players[cs];
      if(cp.hand.length!==1 || cp.calledOne) return {error:"cannot call one"};
      cp.calledOne=true;
      events.push({t:"oneCall", seat:cs});
      return;
    }
    return {error:"unknown action"};
  }

  function pending(s){
    if(s.phase==="turn") return {kind:"turn", seat:s.turn};
    if(s.phase==="suit") return {kind:"suit", seat:s.suitChooser};
    if(s.phase==="ron") return {kind:"ron", seat:s.ron.candidate, drawTriggered:!!s.ron.drawTriggered};
    if(s.phase==="ronReturn") return {kind:"ronReturn", seat:s.ronRet.returner};
    if(s.phase==="roundover") return {kind:"roundover"};
    return {kind:"idle"};
  }

  // ---- AI (returns an action; pure) ----
  function aiPlayAction(s, seat){
    var p=s.players[seat];
    var playable=p.hand.filter(function(c){return matches(s,c);});
    if(playable.length===0) return {type:"draw"};
    var hasTwo=playable.some(function(c){return c.rank===2;});
    if(hasTwo){
      var allTwos=p.hand.filter(function(c){return c.rank===2;});
      var twoSuits={}; allTwos.forEach(function(c){ twoSuits[c.suit]=1; });
      var rest=p.hand.filter(function(c){return c.rank!==2;});
      var follow=null;
      for(var i=0;i<rest.length;i++){ if(twoSuits[rest[i].suit]){ follow=rest[i]; break; } }
      var cards=allTwos.map(function(c){return {suit:c.suit,rank:c.rank};});
      if(follow) cards.push({suit:follow.suit,rank:follow.rank});
      return {type:"play", cards:cards};
    }
    var nonEight=playable.filter(function(c){return c.rank!==8;});
    var pool=(nonEight.length?nonEight:playable).slice().sort(function(a,b){return b.rank-a.rank;});
    var c0=pool[0];
    return {type:"play", cards:[{suit:c0.suit,rank:c0.rank}]};
  }
  function aiSuitAction(s, seat){
    var counts={}; SUITS.forEach(function(x){counts[x]=0;});
    s.players[seat].hand.forEach(function(c){ counts[c.suit]++; });
    var best=SUITS[0]; SUITS.forEach(function(x){ if(counts[x]>counts[best]) best=x; });
    if(counts[best]===0) best=SUITS[Math.floor(Math.random()*4)];
    return {type:"chooseSuit", suit:best};
  }

  // ---- redaction for network play (hide other hands) ----
  function redactFor(state, seat){
    var s=clone(state);
    s.players=s.players.map(function(p,i){ return {score:p.score, count:p.hand.length, hand:(i===seat?p.hand:null), calledOne:!!p.calledOne}; });
    s.deckCount=state.deck.length; s.deck=undefined;
    if(s.ron){ s.ron={candidate:s.ron.candidate, byRank:s.ron.byRank, placer:s.ron.placer, drawTriggered:!!s.ron.drawTriggered}; }
    return s;
  }

  var api = {
    SUITS:SUITS, RED:RED, HAND_SIZE:HAND_SIZE,
    newMatch:newMatch, startRound:startRound, apply:apply, pending:pending,
    validatePlay:validatePlay, aiPlayAction:aiPlayAction, aiSuitAction:aiSuitAction,
    starterMult:starterMult, handSum:handSum, matches:matches, top:top,
    nextSeat:nextSeat, redactFor:redactFor
  };
  if(typeof module!=="undefined" && module.exports) module.exports=api;
  return api;
})();
