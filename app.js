#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import EventEmitter from "events";
import { WebSocketServer, WebSocket } from "ws";
import Bonjour from "bonjour";
import { v4 as uuidv4 } from "uuid";
import blessed from "blessed";
import contrib from "blessed-contrib";
import inquirer from "inquirer";

const CONFIG = {
  PORT_RANGE: { min: 9000, max: 9999 },
  SERVICE_TYPE: "lanos_v4",
  DIR_RECEIVE: path.resolve(process.cwd(), "received"),
  CONFIG_FILE: path.resolve(process.cwd(), "lan-os-config.json"),
};

if (!fs.existsSync(CONFIG.DIR_RECEIVE))
  fs.mkdirSync(CONFIG.DIR_RECEIVE, { recursive: true });

async function loadOrSetupIdentity() {
  if (fs.existsSync(CONFIG.CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG.CONFIG_FILE, "utf-8"));
  }

  console.clear();
  console.log("--- LAN-OS Setup ---");
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "username",
      message: "Enter your Display Name:",
      validate: (input) => (input.length > 0 ? true : "Name cannot be empty."),
    },
  ]);

  const identity = {
    id: uuidv4(),
    username: answers.username,
    device: os.hostname(),
    created: Date.now(),
  };

  fs.writeFileSync(CONFIG.CONFIG_FILE, JSON.stringify(identity, null, 2));
  console.log("Identity saved! Starting OS...");
  await new Promise((r) => setTimeout(r, 1000));
  return identity;
}

const WEB_CLIENT_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LAN-OS Mobile</title>
    <style>
        body { background: #1a1a1a; color: #0f0; font-family: monospace; padding: 0; margin: 0; height: 100vh; display: flex; flex-direction: column; }
        #login-screen { position: absolute; top:0; left:0; width:100%; height:100%; background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 99; }
        .login-box { border: 1px solid #0f0; padding: 20px; text-align: center; }
        #app { display: none; flex-direction: column; height: 100%; padding: 10px; box-sizing: border-box; }
        #log { flex: 1; border: 1px solid #333; overflow-y: scroll; padding: 10px; margin-bottom: 10px; background: #000; }
        .msg { margin: 5px 0; word-wrap: break-word; }
        #controls { display: flex; gap: 5px; height: 50px; }
        input { flex: 1; background: #222; border: 1px solid #444; color: white; padding: 10px; font-size: 16px; }
        button { background: #004400; color: white; border: none; padding: 10px 20px; font-size: 16px; cursor: pointer; }
        #game-board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; max-width: 300px; margin: 10px auto; display: none; }
        .cell { background: #333; height: 60px; display: flex; align-items: center; justify-content: center; font-size: 24px; border: 1px solid #555; }
    </style>
</head>
<body>
    <div id="login-screen">
        <div class="login-box">
            <h2>LAN-OS LOGIN</h2>
            <input type="text" id="username" placeholder="Enter Name" />
            <br><br>
            <button onclick="startApp()">JOIN NETWORK</button>
        </div>
    </div>
    <div id="app">
        <div id="header" style="border-bottom: 1px solid #333; margin-bottom: 10px;"></div>
        <div id="game-board"></div>
        <div id="log"></div>
        <div id="controls">
            <input type="text" id="input" placeholder="Message..." />
            <button onclick="send()">Send</button>
        </div>
    </div>
    <script>
        let ws;
        let myId = Math.random().toString(36).substring(7);
        let myName = "";
        function startApp() {
            const nameInput = document.getElementById('username').value;
            if(!nameInput) return alert("Name required");
            myName = nameInput;
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('app').style.display = 'flex';
            document.getElementById('header').innerText = \`Logged in as: \${myName}\`;
            initWs();
        }
        const boardDiv = document.getElementById('game-board');
        for(let i=0; i<9; i++) {
            let c = document.createElement('div');
            c.className = 'cell';
            c.id = 'c'+i;
            c.onclick = () => { if(ws) ws.send(JSON.stringify({ type: 'game-move', payload: { index: i, symbol: 'O' } })); };
            boardDiv.appendChild(c);
        }
        function log(text, color='white') {
            const d = document.getElementById('log');
            d.innerHTML += \`<div class="msg" style="color:\${color}">\${text}</div>\`;
            d.scrollTop = d.scrollHeight;
        }
        function initWs() {
            ws = new WebSocket('ws://' + window.location.host);
            ws.onopen = () => {
                log('Connected to Host', '#0f0');
                ws.send(JSON.stringify({ type: 'pair', payload: { fromId: myId, name: myName, device: 'Mobile Browser', isWeb: true } }));
            };
            ws.onmessage = (event) => {
                if (event.data instanceof Blob) return;
                try {
                    const { type, payload } = JSON.parse(event.data);
                    if (type === 'msg') log(\`[\${payload.name || payload.fromId.slice(0,4)}]: \${payload.text}\`);
                    if (type === 'game-invite') log('Game Invite! Type /accept to play', 'magenta');
                    if (type === 'game-start') { document.getElementById('game-board').style.display = 'grid'; log('Game Started!', 'magenta'); }
                    if (type === 'game-move') document.getElementById('c'+payload.index).innerText = payload.symbol;
                } catch(e) {}
            };
        }
        function send() {
            const i = document.getElementById('input');
            const txt = i.value;
            if(!txt) return;
            if(txt === '/accept') ws.send(JSON.stringify({ type: 'msg', payload: { fromId: myId, text: '/accept' } })); 
            else ws.send(JSON.stringify({ type: 'msg', payload: { fromId: myId, text: txt } }));
            log('Me: ' + txt, 'cyan');
            i.value = '';
        }
    </script>
</body>
</html>
`;

class TicTacToe {
  constructor() {
    this.board = Array(9).fill(null);
    this.turn = "X";
    this.active = false;
  }
  reset() {
    this.board.fill(null);
    this.turn = "X";
    this.active = true;
  }
  move(idx, sym) {
    if (!this.active || this.board[idx]) return false;
    this.board[idx] = sym;
    this.turn = this.turn === "X" ? "O" : "X";
    return true;
  }
  checkWin() {
    const wins = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ];
    for (let c of wins)
      if (
        this.board[c[0]] &&
        this.board[c[0]] === this.board[c[1]] &&
        this.board[c[0]] === this.board[c[2]]
      )
        return this.board[c[0]];
    if (!this.board.includes(null)) return "DRAW";
    return null;
  }
}

class LanPeer extends EventEmitter {
  constructor(identity) {
    super();
    this.identity = identity;
    this.port = CONFIG.PORT_RANGE.min + Math.floor(Math.random() * 1000);
    this.peers = new Map();
    this.connections = new Map();
    this.game = new TicTacToe();
    this.bonjour = Bonjour();
  }

  start() {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(WEB_CLIENT_HTML);
    });
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (ws) => this._handleConn(ws));

    server.listen(this.port, "0.0.0.0", () => {
      this.bonjour.publish({
        name: this.identity.username,
        type: CONFIG.SERVICE_TYPE,
        port: this.port,
        txt: { id: this.identity.id, device: this.identity.device },
      });
      this.bonjour.find({ type: CONFIG.SERVICE_TYPE }).on("up", (s) => {
        if (!s.txt?.id || s.txt.id === this.identity.id) return;
        this.peers.set(s.txt.id, {
          id: s.txt.id,
          name: s.name,
          device: s.txt.device || "Unknown Device",
          address: s.referer?.address || s.host,
          port: s.port,
        });
        this.emit("peers", Array.from(this.peers.values()));
      });
    });
  }

  connect(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    const ws = new WebSocket(`ws://${p.address}:${p.port}`);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "pair",
          payload: {
            fromId: this.identity.id,
            name: this.identity.username,
            device: this.identity.device,
          },
        })
      );
      this._handleConn(ws);
    });
  }

  _handleConn(ws) {
    let rId = null;
    ws.on("message", (d) => {
      try {
        const msg = JSON.parse(d.toString());
        const { type, payload } = msg;
        if (type === "pair") {
          rId = payload.fromId;
          this.connections.set(rId, { ws, meta: payload });
          this.emit(
            "log",
            `{green-fg}Connected: ${payload.name} (${payload.device}){/}`
          );
          if (!payload.isWeb && !payload.ack) {
            ws.send(
              JSON.stringify({
                type: "pair",
                payload: {
                  fromId: this.identity.id,
                  name: this.identity.username,
                  device: this.identity.device,
                  ack: true,
                },
              })
            );
          }
          this.emit("conn", Array.from(this.connections.values()));
        } else if (type === "msg") {
          const peer = this.connections.get(payload.fromId);
          this.emit(
            "log",
            `{cyan-fg}[${peer ? peer.meta.name : "Unknown"}]:{/} ${
              payload.text
            }`
          );
        } else if (type === "game-move") {
          this.game.move(payload.index, payload.symbol);
          this.emit("game-update");
          this._checkGame();
        }
      } catch (e) {}
    });
    ws.on("close", () => {
      if (rId) {
        const p = this.connections.get(rId);
        this.emit(
          "log",
          `{yellow-fg}Disconnected: ${p ? p.meta.name : rId}{/}`
        );
        this.connections.delete(rId);
      }
      this.emit("conn", Array.from(this.connections.values()));
    });
  }

  chat(text) {
    this.connections.forEach((c) =>
      c.ws.send(
        JSON.stringify({
          type: "msg",
          payload: { fromId: this.identity.id, text },
        })
      )
    );
    this.emit("log", `{blue-fg}Me: ${text}{/}`);
  }

  invite(peerId) {
    const c = this.connections.get(peerId);
    if (c)
      c.ws.send(
        JSON.stringify({
          type: "game-invite",
          payload: { fromId: this.identity.id },
        })
      );
    this.game.reset();
    this.emit("log", `Invited ${c ? c.meta.name : "peer"}. Waiting...`);
  }

  accept(peerId) {
    const c = this.connections.get(peerId);
    this.game.reset();
    if (c)
      c.ws.send(
        JSON.stringify({
          type: "game-start",
          payload: { opponentId: this.identity.id },
        })
      );
    this.emit("game-update");
    this.emit("log", `{magenta-fg}Game Started!{/}`);
  }

  makeMove(idx) {
    if (this.game.move(idx, "X")) {
      this.connections.forEach((c) =>
        c.ws.send(
          JSON.stringify({
            type: "game-move",
            payload: { index: idx, symbol: "X" },
          })
        )
      );
      this.emit("game-update");
      this._checkGame();
    }
  }

  _checkGame() {
    const w = this.game.checkWin();
    if (w) {
      this.emit("log", `{red-fg}GAME OVER: ${w} Wins!{/}`);
      this.game.active = false;
    }
  }
}

(async () => {
  const identity = await loadOrSetupIdentity();
  const node = new LanPeer(identity);

  const screen = blessed.screen({
    smartCSR: false,
    title: `LAN-OS: ${identity.username}`,
    fullUnicode: true,
  });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });
  const pList = grid.set(0, 0, 8, 3, blessed.list, {
    label: " Discovered ",
    style: { selected: { bg: "blue" } },
    keys: true,
    mouse: true,
    border: "line",
  });
  const logBox = grid.set(0, 3, 8, 6, blessed.log, {
    label: ` Log (${identity.username}) `,
    tags: true,
    scrollbar: { bg: "blue" },
    mouse: true,
    border: "line",
  });
  const gameBox = grid.set(0, 9, 8, 3, blessed.box, {
    label: " Game ",
    border: "line",
  });

  const input = grid.set(8, 0, 4, 12, blessed.textbox, {
    label: " Input ",
    keys: true,
    mouse: true,
    inputOnFocus: true,
    border: "line",
    style: { bg: "black", fg: "white" },
  });

  const cells = [];
  for (let i = 0; i < 9; i++) {
    const c = blessed.button({
      parent: gameBox,
      top: 1 + Math.floor(i / 3) * 2,
      left: 2 + (i % 3) * 4,
      width: 3,
      height: 1,
      content: "-",
      style: { bg: "#333" },
      mouse: true,
    });
    c.on("press", () => node.makeMove(i));
    cells.push(c);
  }

  node.on("log", (m) => {
    logBox.log(m);
    screen.render();
  });
  node.on("peers", (l) => {
    pList.setItems(l.map((p) => `${p.name} | ${p.device}`));
    screen.render();
  });
  node.on("conn", (l) => {
    logBox.setLabel(` Log (Connected: ${l.length}) `);
    screen.render();
  });
  node.on("game-update", () => {
    node.game.board.forEach((v, i) => {
      cells[i].setContent(v || "-");
      cells[i].style.bg = v === "X" ? "red" : v === "O" ? "blue" : "#333";
    });
    screen.render();
  });

  pList.on("select", (_, i) => {
    const p = Array.from(node.peers.values())[i];
    if (p) {
      logBox.log(`Connecting to ${p.name}...`);
      node.connect(p.id);
    }
  });

  input.on("submit", (val) => {
    input.clearValue();
    input.focus();
    if (!val) return;
    if (val.startsWith("/play"))
      node.invite(Array.from(node.connections.keys())[0]);
    else if (val.startsWith("/accept"))
      node.accept(Array.from(node.connections.keys())[0]);
    else node.chat(val);
    screen.render();
  });

  node.start();

  const nets = os.networkInterfaces();
  let myIp = "127.0.0.1";
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) myIp = net.address;
    }
  }

  logBox.log(`{bold}Welcome, ${identity.username}!{/}`);
  logBox.log(`Device: ${identity.device}`);
  logBox.log(`Mobile URL: {bold}http://${myIp}:${node.port}{/}`);

  input.focus();
  screen.key(["C-c"], () => process.exit(0));
  screen.render();
})();
