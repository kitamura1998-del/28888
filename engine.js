/* ============================================================
   2と8 — Rule Engine (PURE: no DOM, no audio, no timers)
   Works in the browser (as window-global Engine) and in Node.
   State is plain JSON. apply(state, action) -> {state, events}.
   ============================================================ */
var Engine = (function(){
  "use strict";
  var SUITS = ["\u2660","\u2665","\u2666","\u2663"]; // ♠ ♥ ♦ ♣
  var RED   = {"\u2665":1,"\u2666":1};
  var HAND_SIZE = 5;

  function buildDeck(){ var d=[]; for(var s=0;s<4;s++) for(var r=1;r<=13;r++) d.push({suit:SUITS[s],rank:r}); return d; }
  function shuffle(a,rng){ rng=rng||Math.random; for(var i=a.length-1;i>0;i--){ var j=Math.floor(rng()*(i+1)); var t=a[i];a[i]=a[j];a[j]=t; } return a; }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function nextSeat(i){ return (i+1)%4; }
  function handSum(p){ return p.hand.reduce(function(t,c){return t+c.rank;},0); }
  function top(s){ return s.discard[s.discard.length-1]; }
  function matches(s,c){ if(s.rainbow) return true; return c.suit===s.suit || c.rank===s.rank; }

  function newMatch(prevScores){
    return {
      players:[0,1,2,3].map(function(i){ return {hand:[], score: prevScores?prevScores[i]:0}; }),
      deck:[], discard:[], suit:null, rank:null,
      turn:0, phase:"idle",
      starter:null, comboMult:1, tenpoMult:1, ronTarget:null,
      suitChooser:null, ron:null, result:null, lastWinner:null, starterPenalty:false, rainbow:false
    };
  }

  function startRound(state, startSeat, rng){
    var s = clone(state);
    s.deck = shuffle(buildDeck(), rng);
    s.discard = []; s.players.forEach(function(p){ p.hand=[]; });
    for(var k=0;k<HAND_SIZE;k++) for(var p=0;p<4;p++) s.players[p].hand.push(s.deck.pop());
    var starter = s.deck.pop();
    s.discard=[starter]; s.suit=starter.suit; s.rank=starter.rank; s.starter=starter;
    s.comboMult=1; s.tenpoMult=1; s.ronTarget=null; s.suitChooser=null; s.ron=null; s.result=null; s.rainbow=false;
    s.starterPenalty = (starter.rank===2);   // starter is a 2 -> first player who must draw eats 2
    s.turn=startSeat; s.phase="turn";
    var events=[];
    var sm=starterMult(s);
    if(sm>1) events.push({t:"starterIntro", mult:sm, card:starter});
    // 天保 (tenpo): a player's opening hand SUM equals the starter rank -> instant win, +×5
    var tenpoWinner=-1;
    for(var step=0; step<4; step++){ var i=(startSeat+step)%4; if(handSum(s.players[i])===starter.rank){ tenpoWinner=i; break; } }
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
      if(s.discard.length<=1) return null;
      var keep=s.discard.pop(); s.deck=shuffle(s.discard); s.discard=[keep];
    }
    return s.deck.pop();
  }
  function give(s,seat,n,events){
    for(var k=0;k<n;k++){ var c=drawCard(s); if(!c) break; s.players[seat].hand.push(c); events.push({t:"draw",seat:seat,card:c}); }
  }
  function setField(s,c,seat,events){ s.discard.push(c); s.suit=c.suit; s.rank=c.rank; events.push({t:"place",seat:seat,card:c}); }

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
      if(f<0) return {ok:false,msg:"その札は手札にありません"};
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
  }

  function ronCandidate(s, placer, byRank){
    for(var step=1; step<=3; step++){ var i=(placer+step)%4; if(handSum(s.players[i])===byRank) return i; }
    return -1;
  }

  function scoreRound(s, winner){
    var sM=starterMult(s), cM=s.comboMult||1, tM=s.tenpoMult||1, base=sM*cM*tM;
    var rows=[], pot=0;
    for(var i=0;i<4;i++){
      if(i===winner){ rows.push({seat:i,sum:0,mult:1,win:true,delta:0}); continue; }
      var sum=handSum(s.players[i]);
      var ron=(i===s.ronTarget)?2:1;
      var mult=base*ron, loss=sum*mult;
      pot+=loss; s.players[i].score-=loss;
      rows.push({seat:i,sum:sum,mult:mult,ron:ron>1,win:false,delta:-loss});
    }
    s.players[winner].score+=pot;
    rows.forEach(function(r){ if(r.win) r.delta=pot; });
    s.result={winner:winner,rows:rows,starterMult:sM,comboMult:cM,tenpoMult:tM,starter:s.starter,ronTarget:s.ronTarget,pot:pot};
    s.lastWinner=winner; s.phase="roundover";
  }

  function advance(s){ s.turn=nextSeat(s.turn); s.phase="turn"; }

  function contNormal(s, placer, card, events){
    if(s.players[placer].hand.length===0){ scoreRound(s,placer); events.push({t:"roundOver"}); return; }
    if(card.rank===8){ s.phase="suit"; s.suitChooser=placer; events.push({t:"needSuit",seat:placer}); return; }
    advance(s);
  }
  function contTwoFollow(s, placer, follow, count, events){
    var isCombo=(follow.rank===8);
    if(isCombo){ s.comboMult*=2; events.push({t:"combo",mult:starterMult(s)*s.comboMult,seat:placer}); }
    if(s.players[placer].hand.length===0){ scoreRound(s,placer); events.push({t:"roundOver"}); return; }
    if(isCombo){ s.phase="suit"; s.suitChooser=placer; events.push({t:"needSuit",seat:placer}); return; }
    advance(s);
  }
  function contTwoNoFollow(s, placer, count, events){ advance(s); }

  function afterTwoRon(s, placer, follow, count, events){
    // the 2 was not ron'd: now apply the 2-penalty draws, then resolve the follow card (already on the field)
    var sd=nextSeat(placer);
    for(var st=0; st<3; st++){ give(s, sd, 2*count, events); sd=nextSeat(sd); }
    if(follow){
      var ctxF={kind:"twoFollow", placer:placer, follow:follow, count:count};
      if(!checkRonOr(s, placer, follow.rank, ctxF, events)) contTwoFollow(s, placer, follow, count, events);
    } else {
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

  function checkRonOr(s, placer, byRank, ctx, events){
    var cand=ronCandidate(s, placer, byRank);
    if(cand>=0){
      s.phase="ron"; s.ron={candidate:cand, byRank:byRank, placer:placer, ctx:ctx};
      events.push({t:"ronAvailable", seat:cand, byRank:byRank, placer:placer});
      return true;
    }
    return false;
  }

  function apply(state, action){
    var s=clone(state); var events=[];
    if(action.type==="play"){
      if(s.phase!=="turn") return {state:state, events:[], error:"not your turn"};
      var seat=s.turn, p=s.players[seat];
      s.starterPenalty=false;
      var v=validatePlay(s, seat, action.cards);
      if(!v.ok) return {state:state, events:[{t:"invalid",msg:v.msg}], error:v.msg||"invalid"};
      removeCards(p, action.cards);
      s.rainbow=false;   // a free "rainbow" turn is consumed once a card is played
      if(v.type==="normal"){
        setField(s, v.card, seat, events);
        var ctxN={kind:"normal", placer:seat, card:v.card};
        if(!checkRonOr(s, seat, v.card.rank, ctxN, events)) contNormal(s, seat, v.card, events);
      } else {
        var count=v.twos.length;
        v.twos.forEach(function(c){ setField(s,c,seat,events); });
        if(v.follow){ setField(s, v.follow, seat, events); }   // lay both cards down now so a RON on the 2 can't drop the follow
        events.push({t:"twoEffect", seat:seat, count:count});
        // RON on the 2 is offered BEFORE anyone draws the 2-penalty.
        var ctx2={kind:"afterTwoRon", placer:seat, follow:(v.follow||null), count:count};
        if(!checkRonOr(s, seat, 2, ctx2, events)) afterTwoRon(s, seat, (v.follow||null), count, events);
      }
      return {state:s, events:events};
    }
    if(action.type==="draw"){
      if(s.phase!=="turn") return {state:state, events:[], error:"not your turn"};
      s.rainbow=false;
      var pen = s.starterPenalty; s.starterPenalty=false;
      if(pen){ events.push({t:"starter2", seat:s.turn}); give(s, s.turn, 2, events); }
      else { events.push({t:"turnDraw", seat:s.turn}); give(s, s.turn, 1, events); }
      advance(s);
      return {state:s, events:events};
    }
    if(action.type==="chooseSuit"){
      if(s.phase!=="suit") return {state:state, events:[], error:"no suit pending"};
      if(action.suit==="rainbow"){
        s.rainbow=true;
        events.push({t:"rainbow", seat:s.suitChooser});
      } else {
        s.suit=action.suit;
        events.push({t:"suitChosen", seat:s.suitChooser, suit:action.suit});
      }
      s.suitChooser=null; advance(s);
      return {state:s, events:events};
    }
    if(action.type==="ron"){
      if(s.phase!=="ron") return {state:state, events:[], error:"no ron pending"};
      var r=s.ron; s.ronTarget=r.placer;
      events.push({t:"ron", seat:r.candidate, byRank:r.byRank, placer:r.placer, call:(action.call||"\u30ed\u30f3")});
      scoreRound(s, r.candidate);
      events.push({t:"roundOver"});
      s.ron=null;
      return {state:s, events:events};
    }
    if(action.type==="pass"){
      if(s.phase!=="ron") return {state:state, events:[], error:"no ron pending"};
      var ctx=s.ron.ctx; s.ron=null; s.phase="idle";
      events.push({t:"ronPass"});
      runCont(s, ctx, events);
      return {state:s, events:events};
    }
    return {state:state, events:[], error:"unknown action"};
  }

  function pending(s){
    if(s.phase==="turn") return {kind:"turn", seat:s.turn};
    if(s.phase==="suit") return {kind:"suit", seat:s.suitChooser};
    if(s.phase==="ron") return {kind:"ron", seat:s.ron.candidate};
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
    s.players=s.players.map(function(p,i){ return {score:p.score, count:p.hand.length, hand:(i===seat?p.hand:null)}; });
    s.deckCount=state.deck.length; s.deck=undefined;
    if(s.ron){ s.ron={candidate:s.ron.candidate, byRank:s.ron.byRank, placer:s.ron.placer}; }
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
