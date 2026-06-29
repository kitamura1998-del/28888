/* ============================================================
   2と8 — Authoritative Server  (Node.js + ws)
   - Serves the static client (public/) and /engine.js
   - One true game state per room lives here (Engine is authority)
   - Sends each player only their own hand (redactFor + draw redaction)
   - Empty / disconnected seats are driven by AI
   Run:  npm install   then   node server.js
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const Engine = require("./engine.js");

const PORT = process.env.PORT || 3000;
const AI_DELAY = 800;        // ms between AI moves (pacing)
const AI_DELAY_ONE = 2200;   // slower pacing while a connected human still owes a "ワン" call (gives time to tap)
const RON_TIMEOUT = 10000;   // ms a human has to decide ron before auto-pass
const TURN_TIMEOUT = 60000;  // ms a human has to act before auto-draw
const NEXT_ROUND_DELAY = 6000;
const NEXT_ROUND_FALLBACK = 120000;  // ms: if someone is AFK at round end, start anyway after this

/* ---------------- static file server ---------------- */
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css", ".png":"image/png" };
function serveFile(res, file){
  fs.readFile(file, (err, data) => {
    if(err){ res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}
const server = http.createServer((req, res) => {
  let url = req.url.split("?")[0];
  if(url === "/" ) url = "/index.html";
  if(url === "/engine.js"){ return serveFile(res, path.join(__dirname, "engine.js")); }
  // prevent path traversal
  const safe = path.normalize(url).replace(/^(\.\.[\/\\])+/, "");
  serveFile(res, path.join(PUBLIC, safe));
});

/* ---------------- rooms ---------------- */
const rooms = {};   // code -> room
let nextId = 1;

function makeCode(){
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c; do { c=""; for(let i=0;i<4;i++) c+=A[Math.floor(Math.random()*A.length)]; } while(rooms[c]);
  return c;
}
function newRoom(){
  return { code: makeCode(), seats:[null,null,null,null], hostId:null, state:null, started:false,
           timer:null, nextTimer:null, nextReady:[],
           config:{ players:4, deal:5, ronReturn:false } };
}
function firstEmptySeat(room){ for(let i=0;i<room.seats.length;i++) if(!room.seats[i]) return i; return -1; }
function seatOfClient(room, id){ for(let i=0;i<room.seats.length;i++) if(room.seats[i] && room.seats[i].id===id) return i; return -1; }
function roomInfo(room){
  return { code:room.code, hostId:room.hostId, started:room.started, config:room.config,
    club:room.clubName||null,
    seats: room.seats.map(s => s ? { id:s.id, name:s.name, isAI:!!s.isAI, connected:!!s.connected } : null) };
}

/* ---------------- clubs (leagues shared across devices) ---------------- */
const clubs = {};      // name -> { name, rev, members:[{id,name,score}] }
const clubSubs = {};   // name -> Set<ws> (clients viewing the club lobby)
function memberId(){ return "m"+(nextId++)+Math.random().toString(36).slice(2,6); }
function clubGames(name){ return Object.keys(rooms).map(k=>rooms[k]).filter(r => r.clubName===name); }
function memberBusy(name, mid){ return clubGames(name).some(r => (r.seatMember||[]).indexOf(mid)>=0); }
function clubInfo(name){
  const c=clubs[name]; if(!c) return null;
  const games = clubGames(name).map(r => {
    const names=(r.seatMember||[]).map(mid=>{ const mm=c.members.find(x=>x.id===mid); return mm?mm.name:null; }).filter(Boolean);
    return { gameId:r.code, host:r.hostName, count:r.targetCount, started:!!r.started, joined:names.length, players:names };
  });
  return { name:c.name, rev:c.rev, members:c.members.map(x=>({id:x.id,name:x.name,score:x.score})), games };
}
function broadcastClub(name){
  const info=clubInfo(name); if(!info) return;
  const subs=clubSubs[name]; if(subs) subs.forEach(ws => sendTo(ws, { type:"club", club:info }));
}
function saveClubScores(room){
  const c=clubs[room.clubName]; if(!c || !room.state) return;
  (room.seatMember||[]).forEach((mid,seat)=>{ const mm=c.members.find(x=>x.id===mid); if(mm && room.state.players[seat]) mm.score=room.state.players[seat].score; });
  c.rev++; broadcastClub(room.clubName);
}
// spectators see EVERY hand (deck order stays hidden)
function spectatorView(s){
  const c=JSON.parse(JSON.stringify(s));
  c.players=c.players.map(p=>({score:p.score,count:p.hand.length,hand:p.hand,calledOne:!!p.calledOne}));
  c.deckCount=s.deck.length; c.deck=undefined;
  return c;
}
function gameLobbyInfo(room){
  const c=clubs[room.clubName];
  const players=[];
  for(let seat=0;seat<room.targetCount;seat++){
    const mid=room.seatMember? room.seatMember[seat] : null;
    const s=room.seats[seat];
    if(s && !s.isAI){ players.push({ seat, name:s.name, connected:!!s.connected }); }
    else if(mid){ const mm=c&&c.members.find(x=>x.id===mid); players.push({ seat, name:mm?mm.name:"?", connected:false }); }
  }
  return { gameId:room.code, count:room.targetCount, started:!!room.started, club:room.clubName, players };
}
function sendGameLobby(room){
  room.seats.forEach((s,seat)=>{ if(s && !s.isAI && s.connected) sendTo(s.ws, { type:"gameLobby", lobby:gameLobbyInfo(room), youSeat:seat }); });
}
function startClubGame(room){
  const c=clubs[room.clubName]; if(!c) return;
  room.seats.length=room.targetCount;
  room.started=true;
  const prev=(room.seatMember||[]).map(mid=>{ const mm=c.members.find(x=>x.id===mid); return mm?(mm.score|0):0; });
  room.state=Engine.newMatch(prev, room.config);   // carry-over scores
  startRound(room, Math.floor(Math.random()*room.targetCount));
  broadcastClub(room.clubName);
}
function connectedHumans(room){ return room.seats.filter(s => s && !s.isAI && s.connected); }
function connectedHumanIds(room){ return connectedHumans(room).map(s => s.id); }
// broadcast how many players have pressed "next"
function broadcastNextStatus(room){
  const total = connectedHumans(room).length;
  const ready = room.nextReady.filter(id => connectedHumanIds(room).indexOf(id) >= 0).length;
  room.seats.forEach(s => { if(s && !s.isAI && s.connected && s.ws) sendTo(s.ws, { type:"nextStatus", ready:ready, total:total }); });
}
// start the next round only once every connected human has pressed "next"
function maybeStartNext(room){
  if(!room.started || !room.state) return;
  if(Engine.pending(room.state).kind !== "roundover") return;
  const ids = connectedHumanIds(room);
  if(ids.length === 0) return;
  const allReady = ids.every(id => room.nextReady.indexOf(id) >= 0);
  if(allReady){
    if(room.nextTimer){ clearTimeout(room.nextTimer); room.nextTimer = null; }
    room.nextReady = [];
    startRound(room, room.state.lastWinner);
  }
}

/* ---------------- messaging ---------------- */
function sendTo(ws, obj){ try{ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }catch(e){} }

function redactEvents(events, seat){
  return events.map(ev => {
    if(ev.t === "draw" && ev.seat !== seat){ const c = Object.assign({}, ev); delete c.card; return c; }
    return ev;
  });
}
function broadcastRoom(room){
  room.seats.forEach((s, seat) => { if(s && !s.isAI && s.connected) sendTo(s.ws, { type:"room", room:roomInfo(room), yourSeat:seat, you:{ id:s.id } }); });
}
function broadcastState(room, startSeat){
  room.seats.forEach((s, seat) => {
    if(s && !s.isAI && s.connected)
      sendTo(s.ws, { type:"state", state:Engine.redactFor(room.state, seat), yourSeat:seat, startSeat:(startSeat==null?null:startSeat), room:roomInfo(room) });
  });
  if(room.spectators && room.spectators.length && room.state){
    const full = spectatorView(room.state);
    room.spectators.forEach(sp => sendTo(sp.ws, { type:"state", state:full, yourSeat:-1, spectate:true, startSeat:(startSeat==null?null:startSeat), room:roomInfo(room) }));
  }
}
function broadcastEvents(room, events){
  room.seats.forEach((s, seat) => {
    if(s && !s.isAI && s.connected)
      sendTo(s.ws, { type:"events", events:redactEvents(events, seat), state:Engine.redactFor(room.state, seat) });
  });
  if(room.spectators && room.spectators.length && room.state){
    const full = spectatorView(room.state);
    room.spectators.forEach(sp => sendTo(sp.ws, { type:"events", events:events, state:full, spectate:true }));
  }
}

/* ---------------- game flow ---------------- */
function startRound(room, startSeat){
  if(!room.state) room.state = Engine.newMatch(null, room.config);
  var r = Engine.startRound(room.state, startSeat, Math.random);
  room.state = r.state;
  broadcastState(room, startSeat);
  if(r.events && r.events.length) broadcastEvents(room, r.events);  // starterIntro / tenpo
  advance(room);
}

function advance(room){
  if(room.timer){ clearTimeout(room.timer); room.timer=null; }
  let s = room.state; if(!s) return;
  // AI seats (and disconnected players) auto-declare "ワン" the instant they hit 1 card,
  // so they are never perpetually hit by the ワンペナルティ. Connected humans must tap the button.
  for(let i=0;i<room.seats.length;i++){
    const so = room.seats[i];
    if(so && (so.isAI || !so.connected) && s.players[i] && s.players[i].hand.length===1 && !s.players[i].calledOne){
      const r = Engine.apply(s, { type:"callOne", seat:i });
      if(!r.error){ room.state = r.state; s = r.state; broadcastEvents(room, r.events); }
    }
  }
  const pend = Engine.pending(s);
  if(pend.kind === "roundover"){
    if(room.clubName) saveClubScores(room);   // overwrite club member scores after each round
    // Wait for EVERY connected human to press "next" before starting the next round.
    room.nextReady = [];
    broadcastNextStatus(room);
    if(room.nextTimer) clearTimeout(room.nextTimer);
    // long safety fallback so an AFK player can never permanently stall the table
    room.nextTimer = setTimeout(() => {
      if(connectedHumans(room).length === 0) return;
      room.nextReady = [];
      startRound(room, s.lastWinner);
    }, NEXT_ROUND_FALLBACK);
    return;
  }
  const seatObj = room.seats[pend.seat];
  const isAuto = !seatObj || seatObj.isAI || !seatObj.connected;
  if(isAuto){
    // if a connected human is sitting on 1 uncalled card, slow the CPUs so they can tap "ワン" in time
    const owesOne = room.seats.some((sp,i)=> sp && !sp.isAI && sp.connected && s.players[i] && s.players[i].hand.length===1 && !s.players[i].calledOne);
    room.timer = setTimeout(() => {
      let action;
      if(pend.kind === "turn") action = Engine.aiPlayAction(s, pend.seat);
      else if(pend.kind === "suit") action = Engine.aiSuitAction(s, pend.seat);
      else if(pend.kind === "ronReturn") action = { type:"ronReturn", call:"\u30ed\u30f3\u8fd4\u3057" };  // always beneficial -> auto
      else { if(pend.drawTriggered){ action = { type:"ron", call:"\u5f15\u304d\u30ed\u30f3" }; } else { var calls=["\u30ed\u30f3","\u30c0\u30e1\u301c","\u3054\u9a70\u8d70\u69d8\u3002","\u304a\u75b2\u308c\u69d8\u3002","\u4f55\u8272\u3067\u3059\u304b\uff1f"]; action = { type:"ron", call:calls[Math.floor(Math.random()*calls.length)] }; } }
      doAction(room, pend.seat, action);
    }, owesOne ? AI_DELAY_ONE : AI_DELAY);
  } else {
    // wait for the human, but guard against AFK so the game never stalls
    const ms = (pend.kind === "ron" || pend.kind === "ronReturn") ? RON_TIMEOUT : TURN_TIMEOUT;
    room.timer = setTimeout(() => {
      let action;
      if(pend.kind === "ron") action = { type:"pass" };
      else if(pend.kind === "ronReturn") action = { type:"ronReturn", call:"\u30ed\u30f3\u8fd4\u3057" };  // auto-take the win
      else if(pend.kind === "suit") action = Engine.aiSuitAction(s, pend.seat);
      else action = { type:"draw" };  // AFK on your turn -> draw
      doAction(room, pend.seat, action);
    }, ms);
  }
}

function doAction(room, seat, action){
  const s = room.state; if(!s) return;
  const pend = Engine.pending(s);
  if(pend.kind === "idle" || pend.kind === "roundover") return;
  if(pend.seat !== seat) return;                 // not this seat's decision
  const res = Engine.apply(s, action);
  if(res.error){ return; }                       // ignore illegal action
  room.state = res.state;
  broadcastEvents(room, res.events);
  advance(room);
}

function doCallOne(room, seat){
  const s = room.state; if(!s) return;
  const res = Engine.apply(s, { type:"callOne", seat:seat });
  if(res.error){ return; }
  room.state = res.state;
  broadcastEvents(room, res.events);   // no advance(): declaring "ワン" doesn't change whose turn it is
}

/* ---------------- websocket handlers ---------------- */
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  const client = { id: nextId++, name: "Player", room: null };
  sendTo(ws, { type:"hello", you:{ id: client.id } });

  ws.on("message", (raw) => {
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }

    if(m.type === "hello"){ client.name = (m.name||"Player").slice(0,16); return; }

    if(m.type === "createRoom"){
      const room = newRoom(); rooms[room.code] = room;
      room.seats[0] = { id:client.id, name:client.name, isAI:false, connected:true, ws };
      room.hostId = client.id; client.room = room.code;
      broadcastRoom(room); return;
    }

    if(m.type === "joinRoom"){
      const room = rooms[(m.code||"").toUpperCase()];
      if(!room){ sendTo(ws, { type:"error", msg:"その部屋コードは見つかりません" }); return; }
      if(room.started){ sendTo(ws, { type:"error", msg:"その部屋はすでに開始しています" }); return; }
      const seat = firstEmptySeat(room);
      if(seat < 0){ sendTo(ws, { type:"error", msg:"その部屋は満席です" }); return; }
      room.seats[seat] = { id:client.id, name:client.name, isAI:false, connected:true, ws };
      client.room = room.code;
      broadcastRoom(room); return;
    }

    if(m.type === "start"){
      const room = rooms[client.room]; if(!room || room.started) return;
      if(seatOfClient(room, client.id) < 0) return;   // must be seated in the room
      const N = room.config.players;
      for(let i=0;i<N;i++){ if(!room.seats[i]) room.seats[i] = { id:"ai"+i, name:"CPU", isAI:true, connected:true, ws:null }; }
      room.seats.length = N;                           // trim any extra slots
      room.started = true;
      room.state = Engine.newMatch(null, room.config); // build the match with the chosen rules
      broadcastRoom(room);
      startRound(room, Math.floor(Math.random()*N));
      return;
    }

    /* ---------------- club (multi-device league) ---------------- */
    if(m.type === "clubEnter"){
      const name=(m.name||"").trim().slice(0,24);
      if(!name){ sendTo(ws,{type:"clubError",msg:"クラブ名を入れてください"}); return; }
      const backup=m.backup;
      let c=clubs[name];
      const sanitize=(arr)=> (Array.isArray(arr)?arr:[]).map(x=>({ id:(x&&x.id)||memberId(), name:String((x&&x.name)||"?").slice(0,12), score:(x&&x.score|0)||0 }));
      if(!c){
        c={ name, rev:(backup&&(backup.rev|0))||0, members: backup?sanitize(backup.members):[] };
        clubs[name]=c;
      } else if(backup && (backup.rev|0) > c.rev){      // client has newer data (server restarted) -> restore
        c.members=sanitize(backup.members); c.rev=backup.rev|0;
      }
      // leave any previous club subscription
      if(client.club && client.club!==name && clubSubs[client.club]) clubSubs[client.club].delete(ws);
      client.club=name;
      if(!clubSubs[name]) clubSubs[name]=new Set();
      clubSubs[name].add(ws);
      sendTo(ws,{type:"club", club:clubInfo(name)});
      return;
    }
    if(m.type === "clubAddMember"){
      const c=clubs[client.club]; if(!c) return;
      const nm=(m.name||"").trim().slice(0,12); if(!nm) return;
      c.members.push({ id:memberId(), name:nm, score:0 }); c.rev++;
      broadcastClub(client.club); return;
    }
    if(m.type === "clubRemoveMember"){
      const c=clubs[client.club]; if(!c) return;
      if(memberBusy(client.club, m.memberId)){ sendTo(ws,{type:"clubError",msg:"プレイ中の人は消せません"}); return; }
      c.members=c.members.filter(x=>x.id!==m.memberId); c.rev++;
      broadcastClub(client.club); return;
    }
    if(m.type === "clubResetScores"){
      const c=clubs[client.club]; if(!c) return;
      c.members.forEach(x=>x.score=0); c.rev++; broadcastClub(client.club); return;
    }
    if(m.type === "clubDelete"){
      const name=client.club; const c=clubs[name]; if(!c) return;
      clubGames(name).forEach(r => { if(r.timer) clearTimeout(r.timer); if(r.nextTimer) clearTimeout(r.nextTimer); delete rooms[r.code]; });
      const subs=clubSubs[name];
      delete clubs[name]; delete clubSubs[name];
      if(subs) subs.forEach(w => sendTo(w, { type:"clubDeleted", name }));   // kick everyone back to the entry screen
      return;
    }
    if(m.type === "clubLeave"){
      if(client.club && clubSubs[client.club]) clubSubs[client.club].delete(ws);
      client.club=null; return;
    }
    if(m.type === "clubCreateGame"){
      const c=clubs[client.club]; if(!c){ sendTo(ws,{type:"clubError",msg:"クラブに入っていません"}); return; }
      const mem=c.members.find(x=>x.id===m.memberId);
      if(!mem){ sendTo(ws,{type:"clubError",msg:"自分の名前を選んでください"}); return; }
      if(memberBusy(client.club, m.memberId)){ sendTo(ws,{type:"clubError",msg:"その人は別のゲームに参加中です"}); return; }
      const count=Math.max(3,Math.min(5, (m.players|0)||4));
      const room=newRoom(); rooms[room.code]=room;
      room.clubName=client.club; room.targetCount=count;
      room.config={ players:count, deal:(m.deal===4||m.deal===5)?m.deal:5, ronReturn:!!m.ronReturn };
      room.seats=new Array(count).fill(null);
      room.seatMember=new Array(count).fill(null);
      room.spectators=[];
      room.hostId=client.id; room.hostName=mem.name;
      room.seats[0]={ id:client.id, name:mem.name, isAI:false, connected:true, ws };
      room.seatMember[0]=m.memberId; client.room=room.code;
      sendGameLobby(room); broadcastClub(client.club);
      return;
    }
    if(m.type === "clubJoinGame"){
      const room=rooms[m.gameId]; const c=clubs[client.club];
      if(!room || !c || room.clubName!==client.club){ sendTo(ws,{type:"clubError",msg:"そのゲームが見つかりません"}); return; }
      if(room.started){ sendTo(ws,{type:"clubError",msg:"もう始まっています（観戦できます）"}); return; }
      const mem=c.members.find(x=>x.id===m.memberId);
      if(!mem){ sendTo(ws,{type:"clubError",msg:"自分の名前を選んでください"}); return; }
      if((room.seatMember||[]).indexOf(m.memberId)>=0){ sendTo(ws,{type:"clubError",msg:"その人はもう参加しています"}); return; }
      if(memberBusy(client.club, m.memberId)){ sendTo(ws,{type:"clubError",msg:"その人は別のゲームに参加中です"}); return; }
      const seat=firstEmptySeat(room); if(seat<0 || seat>=room.targetCount){ sendTo(ws,{type:"clubError",msg:"満員です"}); return; }
      room.seats[seat]={ id:client.id, name:mem.name, isAI:false, connected:true, ws };
      room.seatMember[seat]=m.memberId; client.room=room.code;
      sendGameLobby(room); broadcastClub(client.club);
      const joined=room.seats.filter(s=>s&&!s.isAI&&s.connected).length;
      if(joined>=room.targetCount) startClubGame(room);    // everyone here -> go
      return;
    }
    if(m.type === "clubSpectate"){
      const room=rooms[m.gameId];
      if(!room || room.clubName!==client.club){ sendTo(ws,{type:"clubError",msg:"見つかりません"}); return; }
      if(!room.spectators) room.spectators=[];
      if(!room.spectators.some(sp=>sp.id===client.id)) room.spectators.push({ id:client.id, ws });
      client.spectating=room.code;
      sendTo(ws,{ type:"state", state: room.state?spectatorView(room.state):null, yourSeat:-1, spectate:true, room:roomInfo(room) });
      return;
    }
    if(m.type === "clubLeaveGame"){
      if(client.spectating){ const r=rooms[client.spectating]; if(r&&r.spectators) r.spectators=r.spectators.filter(sp=>sp.id!==client.id); client.spectating=null; }
      if(client.room){ const r=rooms[client.room];
        if(r){ const seat=seatOfClient(r,client.id);
          if(seat>=0){
            if(!r.started){ r.seats[seat]=null; if(r.seatMember) r.seatMember[seat]=null;
              if(r.clubName && r.seats.filter(x=>x&&!x.isAI&&x.connected).length===0){ delete rooms[r.code]; broadcastClub(r.clubName); }
              else { sendGameLobby(r); broadcastClub(r.clubName); } }
            else {   // started game: hand the seat to AI, keep the others playing
              r.seats[seat].connected=false;
              if(connectedHumans(r).length===0){
                if(r.timer) clearTimeout(r.timer); if(r.nextTimer) clearTimeout(r.nextTimer);
                if(r.clubName) saveClubScores(r);
                delete rooms[r.code];
              } else if(Engine.pending(r.state).kind==="roundover"){ broadcastNextStatus(r); maybeStartNext(r); }
              else advance(r);
              if(r.clubName) broadcastClub(r.clubName);
            }
          }
        }
        client.room=null;
      }
      if(client.club) sendTo(ws,{ type:"club", club:clubInfo(client.club) });
      return;
    }

    if(m.type === "config"){
      const room = rooms[client.room]; if(!room || room.started) return;
      if(room.hostId !== client.id) return;            // host only
      const cfg = m.config || {};
      if(cfg.players != null){
        const P = Math.max(3, Math.min(5, cfg.players|0));
        // don't shrink past a seated human
        let ok = true;
        for(let i=P;i<room.seats.length;i++){ if(room.seats[i] && !room.seats[i].isAI){ ok=false; break; } }
        if(!ok){ sendTo(ws, { type:"error", msg:"その人数だと座っている人がはみ出します" }); }
        else {
          const ns=[]; for(let i=0;i<P;i++) ns[i]=room.seats[i]||null; room.seats=ns;
          room.config.players=P;
        }
      }
      if(cfg.deal===4 || cfg.deal===5) room.config.deal=cfg.deal;
      if(typeof cfg.ronReturn === "boolean") room.config.ronReturn=cfg.ronReturn;
      broadcastRoom(room);
      return;
    }

    if(m.type === "action"){
      const room = rooms[client.room]; if(!room || !room.started) return;
      const seat = seatOfClient(room, client.id); if(seat < 0) return;
      doAction(room, seat, m.action || {});
      return;
    }

    if(m.type === "callOne"){
      const room = rooms[client.room]; if(!room || !room.started) return;
      const seat = seatOfClient(room, client.id); if(seat < 0) return;
      doCallOne(room, seat);
      return;
    }

    if(m.type === "say"){
      const room = rooms[client.room]; if(!room || !room.started) return;
      const seat = seatOfClient(room, client.id); if(seat < 0) return;
      const text = String(m.text||"").slice(0,24);
      room.seats.forEach((s, i) => { if(s && !s.isAI && s.connected) sendTo(s.ws, { type:"say", seat:seat, text:text }); });
      return;
    }

    if(m.type === "next"){
      const room = rooms[client.room]; if(!room || !room.started || !room.state) return;
      if(Engine.pending(room.state).kind !== "roundover") return;   // only when a round has ended
      if(room.nextReady.indexOf(client.id) < 0) room.nextReady.push(client.id);
      broadcastNextStatus(room);
      maybeStartNext(room);
      return;
    }
  });

  ws.on("close", () => {
    // leave club lobby subscription
    if(client.club && clubSubs[client.club]) clubSubs[client.club].delete(ws);
    // leave spectating
    if(client.spectating){ const sr=rooms[client.spectating]; if(sr&&sr.spectators) sr.spectators=sr.spectators.filter(sp=>sp.id!==client.id); client.spectating=null; }
    const room = rooms[client.room]; if(!room) return;
    const seat = seatOfClient(room, client.id);
    if(seat < 0) return;
    if(!room.started){
      room.seats[seat] = null;                       // free the seat in lobby
      if(room.seatMember) room.seatMember[seat]=null;
      if(room.hostId === client.id){ const h = room.seats.find(x=>x&&!x.isAI); room.hostId = h?h.id:null; }
      if(connectedHumans(room).length === 0){ delete rooms[room.code]; if(room.clubName) broadcastClub(room.clubName); }
      else { if(room.clubName){ sendGameLobby(room); broadcastClub(room.clubName); } else broadcastRoom(room); }
    } else {
      room.seats[seat].connected = false;            // hand over to AI mid-game
      if(connectedHumans(room).length === 0){
        if(room.timer) clearTimeout(room.timer);
        if(room.nextTimer) clearTimeout(room.nextTimer);
        if(room.clubName) saveClubScores(room);      // keep the latest league scores before dropping the room
        delete rooms[room.code];
        if(room.clubName) broadcastClub(room.clubName);
      } else {
        if(room.clubName) broadcastClub(room.clubName); else broadcastRoom(room);
        if(Engine.pending(room.state).kind === "roundover"){
          broadcastNextStatus(room);   // a leaver no longer needs to press "next"
          maybeStartNext(room);
        } else {
          advance(room);                             // keep the game moving
        }
      }
    }
  });
});

server.listen(PORT, () => { console.log("2と8 server on http://localhost:" + PORT); });
