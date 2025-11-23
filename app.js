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

// --- CONFIG ---
const CONFIG = {
  PORT_RANGE: { min: 9000, max: 9999 },
  SERVICE_TYPE: "lanos_v6_fix",
  DIR_RECEIVE: path.resolve(process.cwd(), "received"),
  CONFIG_FILE: path.resolve(process.cwd(), "lan-os-config.json"),
  CHUNK_SIZE: 16 * 1024,
};

if (!fs.existsSync(CONFIG.DIR_RECEIVE))
  fs.mkdirSync(CONFIG.DIR_RECEIVE, { recursive: true });

// --- PROTOCOL ---
class Protocol {
  static createBinary(fileId, chunk) {
    const header = JSON.stringify({ fileId });
    const hBuf = Buffer.from(header, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(hBuf.length, 0);
    return Buffer.concat([lenBuf, hBuf, chunk]);
  }
  static parseBinary(buf) {
    if (buf.length < 4) return null;
    const hLen = buf.readUInt32BE(0);
    if (buf.length < 4 + hLen) return null;
    try {
      return {
        header: JSON.parse(buf.subarray(4, 4 + hLen).toString("utf8")),
        data: buf.subarray(4 + hLen),
      };
    } catch {
      return null;
    }
  }
}

// --- IDENTITY ---
async function loadOrSetupIdentity() {
  if (fs.existsSync(CONFIG.CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG.CONFIG_FILE, "utf-8"));
  }
  console.clear();
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "username",
      message: "Enter Display Name:",
      validate: (i) => (i.length > 0 ? true : "Required."),
    },
  ]);
  const identity = {
    id: uuidv4(),
    username: answers.username,
    device: os.hostname(),
  };
  fs.writeFileSync(CONFIG.CONFIG_FILE, JSON.stringify(identity, null, 2));
  return identity;
}

// --- WEB CLIENT (MOBILE) ---
const WEB_CLIENT_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LAN-OS Mobile</title>
    <style>
        body { background: #111; color: #0f0; font-family: monospace; display: flex; flex-direction: column; height: 100vh; margin:0; }
        #login { position: fixed; top:0; left:0; width:100%; height:100%; background:#000; display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:9; }
        #app { display:none; flex-direction:column; height:100%; padding:10px; }
        #header { border-bottom: 1px solid #333; padding-bottom: 5px; margin-bottom: 5px; color: yellow; }
        #log { flex:1; overflow-y:scroll; border:1px solid #333; padding:5px; margin-bottom:5px; background: #000; }
        .msg { margin: 2px 0; word-break: break-all; }
        input, button { padding:10px; background:#222; color:#fff; border:1px solid #444; }
        #ctrl { display:flex; gap:5px; } input { flex:1; }
    </style>
</head>
<body>
    <div id="login"><h2>LAN-OS v6</h2><input id="u" placeholder="Name"><br><button onclick="join()">JOIN GENERAL</button></div>
    <div id="app"><div id="header">Channel: #General</div><div id="log"></div><div id="ctrl"><input id="i"><button onclick="send()">Send</button></div></div>
    <script>
        let ws, id = Math.random().toString(36).substr(2), name;
        function join() {
            name = document.getElementById('u').value;
            if(!name) return;
            document.getElementById('login').style.display='none';
            document.getElementById('app').style.display='flex';
            ws = new WebSocket('ws://'+location.host);
            ws.binaryType = 'arraybuffer';
            ws.onopen = () => ws.send(JSON.stringify({type:'pair', payload:{fromId:id, name, device:'Mobile', isWeb:true}}));
            ws.onmessage = (e) => {
                if(e.data instanceof ArrayBuffer) return;
                try {
                    const {type, payload} = JSON.parse(e.data);
                    if(type==='msg') log(\`[\${payload.name}]: \${payload.text}\`, payload.isPm ? '#f0f' : '#fff');
                    if(type==='game-invite') log('Game Invite received! (Games restricted to Desktop)', 'red');
                } catch(x){}
            };
        }
        function log(t,c='#fff') { const d=document.getElementById('log'); d.innerHTML+=\`<div class="msg" style="color:\${c}">\${t}</div>\`; d.scrollTop=d.scrollHeight; }
        function send() {
            const i=document.getElementById('i'); if(!i.value)return;
            ws.send(JSON.stringify({type:'msg', payload:{fromId:id, text:i.value}}));
            log('Me: '+i.value, '#0ff'); i.value='';
        }
    </script>
</body>
</html>
`;

// --- GAME LOGIC ---
class TicTacToe {
  constructor() {
    this.reset();
  }
  reset() {
    this.board = Array(9).fill(null);
    this.turn = "X";
    this.active = true;
  }
  move(i, s) {
    if (!this.active || this.board[i]) return false;
    this.board[i] = s;
    this.turn = s === "X" ? "O" : "X";
    return true;
  }
  checkWin() {
    const w = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ];
    for (let c of w)
      if (
        this.board[c[0]] &&
        this.board[c[0]] === this.board[c[1]] &&
        this.board[c[0]] === this.board[c[2]]
      )
        return this.board[c[0]];
    return !this.board.includes(null) ? "DRAW" : null;
  }
}

// --- NODE (The Engine) ---
class LanPeer extends EventEmitter {
  constructor(identity) {
    super();
    this.identity = identity;
    this.port = CONFIG.PORT_RANGE.min + Math.floor(Math.random() * 1000);
    this.peers = new Map();
    this.conns = new Map();
    this.transfers = new Map();
    this.game = new TicTacToe();
    this.bonjour = Bonjour();
    this.activeChannel = "general";
  }

  start() {
    const server = http.createServer((q, r) => {
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end(WEB_CLIENT_HTML);
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
        if (s.txt?.id && s.txt.id !== this.identity.id) {
          this.peers.set(s.txt.id, {
            id: s.txt.id,
            name: s.name,
            device: s.txt.device,
            address: s.referer?.address || s.host,
            port: s.port,
          });
          this.emit("peers", Array.from(this.peers.values()));
        }
      });
    });
  }

  connect(id) {
    const p = this.peers.get(id);
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
    ws.binaryType = "arraybuffer";
    let rid = null;
    ws.on("message", (data, isBin) => {
      if (isBin) {
        const parsed = Protocol.parseBinary(Buffer.from(data));
        if (parsed) this._handleChunk(parsed);
      } else {
        try {
          const { type, payload } = JSON.parse(data.toString());
          if (type === "pair") {
            rid = payload.fromId;
            this.conns.set(rid, { ws, meta: payload });
            this.emit("log", `{green-fg}User Joined: ${payload.name}{/}`);
            if (!payload.isWeb && !payload.ack)
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
            this.emit("conn", Array.from(this.conns.values()));
          } else if (type === "msg") {
            const sender =
              this.conns.get(payload.fromId)?.meta.name || "Unknown";
            if (payload.isPm) {
              this.emit(
                "log",
                `{magenta-fg}[DM ${sender}]: ${payload.text}{/}`
              );
            } else {
              this.emit(
                "log",
                `{cyan-fg}[#General ${sender}]:{/} ${payload.text}`
              );
            }
          } else if (type === "file-offer") {
            this.emit(
              "log",
              `{yellow-fg}Receiving file from ${payload.fromName}: ${payload.filename}{/}`
            );
            const fpath = path.join(
              CONFIG.DIR_RECEIVE,
              `${Date.now()}_${payload.filename}`
            );
            this.transfers.set(payload.fileId, {
              stream: fs.createWriteStream(fpath),
              path: fpath,
            });
          } else if (type === "file-end") {
            const t = this.transfers.get(payload.fileId);
            if (t) {
              t.stream.end();
              this.emit("log", `{green-fg}File Saved: ${t.path}{/}`);
            }
          } else if (type === "game-invite")
            this.emit(
              "log",
              `{magenta-fg}Game Invite from ${payload.fromName}! Type /accept{/}`
            );
          else if (type === "game-start") {
            this.game.reset();
            this.emit("game-update");
            this.emit("log", `{magenta-fg}Game Started!{/}`);
          } else if (type === "game-move") {
            this.game.move(payload.index, payload.symbol);
            this.emit("game-update");
            this._checkGame();
          }
        } catch (e) {}
      }
    });
    ws.on("close", () => {
      if (rid) {
        this.conns.delete(rid);
        this.emit("conn", Array.from(this.conns.values()));
      }
    });
  }

  _handleChunk({ header, data }) {
    const t = this.transfers.get(header.fileId);
    if (t) t.stream.write(data);
  }

  sendMsg(text) {
    if (this.activeChannel === "general") {
      this.conns.forEach((c) =>
        c.ws.send(
          JSON.stringify({
            type: "msg",
            payload: {
              fromId: this.identity.id,
              name: this.identity.username,
              text,
              isPm: false,
            },
          })
        )
      );
      this.emit("log", `{blue-fg}[#General Me]: ${text}{/}`);
    } else {
      const target = this.conns.get(this.activeChannel);
      if (target) {
        target.ws.send(
          JSON.stringify({
            type: "msg",
            payload: {
              fromId: this.identity.id,
              name: this.identity.username,
              text,
              isPm: true,
            },
          })
        );
        this.emit("log", `{magenta-fg}[DM -> ${target.meta.name}]: ${text}{/}`);
      } else {
        this.emit("log", `{red-fg}User not connected. Switched to General.{/}`);
        this.activeChannel = "general";
      }
    }
  }

  sendFile(fpath) {
    if (!fs.existsSync(fpath))
      return this.emit("log", `{red-fg}File not found{/}`);
    const targets =
      this.activeChannel === "general"
        ? Array.from(this.conns.values())
        : [this.conns.get(this.activeChannel)].filter(Boolean);
    if (targets.length === 0)
      return this.emit("log", `{red-fg}No one to receive file.{/}`);
    const fname = path.basename(fpath);
    const fsize = fs.statSync(fpath).size;
    const fid = uuidv4();
    targets.forEach((t) =>
      t.ws.send(
        JSON.stringify({
          type: "file-offer",
          payload: {
            fromId: this.identity.id,
            fromName: this.identity.username,
            fileId: fid,
            filename: fname,
            size: fsize,
          },
        })
      )
    );
    const stream = fs.createReadStream(fpath, {
      highWaterMark: CONFIG.CHUNK_SIZE,
    });
    stream.on("data", (chunk) => {
      const bin = Protocol.createBinary(fid, chunk);
      targets.forEach((t) => t.ws.send(bin));
    });
    stream.on("end", () => {
      targets.forEach((t) =>
        t.ws.send(
          JSON.stringify({ type: "file-end", payload: { fileId: fid } })
        )
      );
      this.emit(
        "log",
        `{green-fg}Sent: ${fname} to ${
          this.activeChannel === "general" ? "everyone" : "peer"
        }{/}`
      );
    });
  }

  invite() {
    this.game.reset();
    const targets =
      this.activeChannel === "general"
        ? Array.from(this.conns.values())
        : [this.conns.get(this.activeChannel)].filter(Boolean);
    targets.forEach((t) =>
      t.ws.send(
        JSON.stringify({
          type: "game-invite",
          payload: {
            fromId: this.identity.id,
            fromName: this.identity.username,
          },
        })
      )
    );
    this.emit(
      "log",
      `Invited ${
        this.activeChannel === "general" ? "everyone" : "peer"
      } to Game.`
    );
  }

  accept() {
    this.game.reset();
    const targets =
      this.activeChannel === "general"
        ? Array.from(this.conns.values())
        : [this.conns.get(this.activeChannel)].filter(Boolean);
    targets.forEach((t) =>
      t.ws.send(
        JSON.stringify({
          type: "game-start",
          payload: { opponentId: this.identity.id },
        })
      )
    );
    this.emit("game-update");
    this.emit("log", `{magenta-fg}Game Started!{/}`);
  }

  makeMove(i) {
    if (this.game.move(i, "X")) {
      const targets =
        this.activeChannel === "general"
          ? Array.from(this.conns.values())
          : [this.conns.get(this.activeChannel)].filter(Boolean);
      targets.forEach((t) =>
        t.ws.send(
          JSON.stringify({
            type: "game-move",
            payload: { index: i, symbol: "X" },
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

// --- BOOTSTRAP ---
(async () => {
  const identity = await loadOrSetupIdentity();
  const node = new LanPeer(identity);

  const screen = blessed.screen({
    smartCSR: false,
    title: `LAN-OS v6`,
    fullUnicode: true,
  });
  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  // Layout
  const pList = grid.set(0, 0, 8, 3, blessed.list, {
    label: " 1. Discovered ",
    keys: true,
    mouse: true,
    style: { selected: { bg: "blue" } },
    border: "line",
  });
  const cList = grid.set(8, 0, 4, 3, blessed.list, {
    label: " 2. Chats ",
    keys: true,
    mouse: true,
    style: { selected: { bg: "magenta" } },
    border: "line",
  });
  const logBox = grid.set(0, 3, 8, 6, blessed.log, {
    label: ` Chat: #General `,
    tags: true,
    mouse: true,
    scrollbar: { bg: "blue" },
    border: "line",
  });
  const gameBox = grid.set(0, 9, 8, 3, blessed.box, {
    label: " Game ",
    border: "line",
  });

  // FIX: Using a dumb BOX instead of Textbox to prevent double typing
  const inputBox = grid.set(8, 3, 4, 9, blessed.box, {
    label: " Message (Type here) ",
    border: "line",
    style: { bg: "black", fg: "white" },
  });

  cList.setItems(["#General"]);

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
    pList.setItems(l.map((p) => `${p.name}`));
    screen.render();
  });
  node.on("conn", (l) => {
    const names = ["#General", ...l.map((c) => c.meta.name)];
    cList.setItems(names);
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

  cList.on("select", (item, i) => {
    const name = item.content;
    if (name === "#General") {
      node.activeChannel = "general";
      logBox.setLabel(" Chat: #General ");
    } else {
      const target = Array.from(node.conns.values()).find(
        (c) => c.meta.name === name
      );
      if (target) {
        node.activeChannel = target.meta.fromId;
        logBox.setLabel(` Chat: DM @${name} `);
      }
    }
    screen.render();
  });

  // --- MANUAL INPUT HANDLER (THE FIX) ---
  let currentInput = "";

  const updateInput = () => {
    inputBox.setContent(currentInput + "_"); // Add cursor
    screen.render();
  };

  screen.on("keypress", (ch, key) => {
    // Handle Global Exit
    if (key.name === "c" && key.ctrl) process.exit(0);

    // Handle Tab Switching
    if (key.name === "tab") {
      screen.focusNext();
      screen.render();
      return;
    }

    // Handle Input Logic (Only if inputBox is focused)
    // Note: We assume input is focused if lists aren't
    if (
      inputBox === screen.focused ||
      (screen.focused !== pList && screen.focused !== cList)
    ) {
      if (key.name === "return" || key.name === "enter") {
        if (!currentInput) return;
        const val = currentInput;
        currentInput = "";
        updateInput();

        if (val.startsWith("/play")) node.invite();
        else if (val.startsWith("/accept")) node.accept();
        else if (val.startsWith("/send "))
          node.sendFile(val.split("/send ")[1].trim());
        else node.sendMsg(val);
      } else if (key.name === "backspace") {
        currentInput = currentInput.slice(0, -1);
        updateInput();
      } else if (ch && !key.ctrl && !key.meta && ch.length === 1) {
        currentInput += ch;
        updateInput();
      }
    }
  });

  // Set initial focus
  inputBox.focus();

  node.start();
  const ip =
    Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i.family === "IPv4" && !i.internal)?.address || "127.0.0.1";
  logBox.log(`{bold}Welcome ${identity.username}!{/}`);
  logBox.log(`Mobile Link: {bold}http://${ip}:${node.port}{/}`);
  logBox.log(`Default Channel: #General. Click "Active Chats" to DM.`);

  screen.render();
})();
