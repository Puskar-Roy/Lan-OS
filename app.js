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
import { exec } from "child_process";


const CONFIG = {
  PORT_RANGE: { min: 9000, max: 9999 },
  SERVICE_TYPE: "lanos_omega_v11",
  DIR_RECEIVE: path.resolve(process.cwd(), "received_files"),
  CONFIG_FILE: path.resolve(process.cwd(), "lan-identity.json"),
  PING_INTERVAL: 3000,
  CHUNK_SIZE: 16 * 1024,
};

if (!fs.existsSync(CONFIG.DIR_RECEIVE))
  fs.mkdirSync(CONFIG.DIR_RECEIVE, { recursive: true });


const getIP = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i.family === "IPv4" && !i.internal)?.address || "127.0.0.1";

const COLORS = {
  sys: "{yellow-fg}",
  err: "{red-fg}",
  dm: "{magenta-fg}",
  gen: "{cyan-fg}",
  me: "{green-fg}",
  file: "{blue-fg}",
  cmd: "{bold}{white-fg}",
  reset: "{/}",
};


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


class GameEngine {
  constructor() {
    this.reset();
  }
  reset() {
    this.active = false;
    this.board = Array(9).fill(null);
    this.turn = "X";
    this.myRole = null;
  }
  move(idx, role) {
    if (!this.active || this.board[idx]) return false;
    if (role === this.myRole && this.turn !== this.myRole) return false;
    this.board[idx] = role;
    this.turn = role === "X" ? "O" : "X";
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


class NetworkNode extends EventEmitter {
  constructor(identity) {
    super();
    this.identity = identity;
    this.port = CONFIG.PORT_RANGE.min + Math.floor(Math.random() * 1000);
    this.peers = new Map();
    this.conns = new Map();
    this.transfers = new Map();
    this.game = new GameEngine();
    this.bonjour = Bonjour();
    this.activeTarget = "general";

   
    this.pendingShell = null; 
  }

  start() {
    const server = http.createServer((q, r) => {
      r.writeHead(200);
      r.end("LAN-OS OMEGA");
    });
    this.wss = new WebSocketServer({ server });

    
    setInterval(() => {
      this.conns.forEach((c) => {
        if (c.isAlive === false) return c.ws.terminate();
        c.isAlive = false;
        c.ws.ping();
      });
    }, CONFIG.PING_INTERVAL);

    this.wss.on("connection", (ws) => this._handleConn(ws));
    server.listen(this.port, "0.0.0.0", () => {
      this._startDiscovery();
      this.emit("ready", this.port);
    });
  }

  _startDiscovery() {
    this.bonjour.publish({
      name: this.identity.username,
      type: CONFIG.SERVICE_TYPE,
      port: this.port,
      txt: { id: this.identity.id },
    });
    this.bonjour.find({ type: CONFIG.SERVICE_TYPE }).on("up", (s) => {
      if (s.txt?.id && s.txt.id !== this.identity.id) {
        this.peers.set(s.txt.id, {
          id: s.txt.id,
          name: s.name,
          address: s.referer?.address || s.host,
          port: s.port,
        });
        this.emit("peers_update");
      }
    });
    this.bonjour.find({ type: CONFIG.SERVICE_TYPE }).on("down", (s) => {
      if (s.txt?.id) {
        this.peers.delete(s.txt.id);
        this.emit("peers_update");
      }
    });
  }

  connect(id) {
    const p = this.peers.get(id);
    if (!p) return;
    const ws = new WebSocket(`ws://${p.address}:${p.port}`);
    ws.on("open", () => {
      this._send(ws, "pair", {
        fromId: this.identity.id,
        name: this.identity.username,
      });
      this._handleConn(ws);
    });
  }

  _handleConn(ws) {
    let peerId = null;
    ws.binaryType = "arraybuffer";
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const parsed = Protocol.parseBinary(Buffer.from(data));
        if (parsed && this.transfers.has(parsed.header.fileId)) {
          this.transfers.get(parsed.header.fileId).stream.write(parsed.data);
        }
        return;
      }

      try {
        const { type, payload } = JSON.parse(data.toString());

        switch (type) {
          case "pair":
            peerId = payload.fromId;
            this.conns.set(peerId, { ws, meta: payload, isAlive: true });
            this.emit("conns_update");
            if (!payload.ack)
              this._send(ws, "pair", {
                fromId: this.identity.id,
                name: this.identity.username,
                ack: true,
              });
            break;

          case "msg":
            this.emit("chat", payload);
            break;

          
          case "nudge":
            this.emit("nudge_event", payload.fromName);
            break;

          
          case "shell-req":
            this.pendingShell = { fromId: payload.fromId, cmd: payload.cmd };
            this.emit(
              "log",
              `${COLORS.err}[SECURITY WARNING]${COLORS.reset} ${payload.fromName} wants to run: ${COLORS.cmd}${payload.cmd}${COLORS.reset}`
            );
            this.emit(
              "log",
              `Type ${COLORS.cmd}/allow${COLORS.reset} to execute or ignore to deny.`
            );
            break;

          case "shell-out":
            this.emit(
              "log",
              `${COLORS.cmd}[REMOTE OUTPUT]:${COLORS.reset}\n${payload.output}`
            );
            break;

          
          case "file-offer":
            this.emit(
              "log",
              `${COLORS.file}Receiving file: ${payload.filename}${COLORS.reset}`
            );
            const fpath = path.join(
              CONFIG.DIR_RECEIVE,
              `${Date.now()}_${payload.filename}`
            );
            this.transfers.set(payload.fileId, {
              stream: fs.createWriteStream(fpath),
              path: fpath,
            });
            break;

          case "file-end":
            const t = this.transfers.get(payload.fileId);
            if (t) {
              t.stream.end();
              this.emit(
                "log",
                `${COLORS.me}File Saved: ${t.path}${COLORS.reset}`
              );
              this.transfers.delete(payload.fileId);
            }
            break;

          
          case "game-invite":
            this.emit(
              "log",
              `${COLORS.dm}INVITE: ${payload.name} wants to play! Type /accept${COLORS.reset}`
            );
            this.activeTarget = payload.fromId;
            break;
          case "game-start":
            this.game.start(payload.role || "X");
            this.emit("game_update");
            this.emit(
              "log",
              `${COLORS.dm}Game Started! You are ${payload.role || "X"}${
                COLORS.reset
              }`
            );
            break;
          case "game-move":
            this.game.move(payload.idx, payload.role);
            this.emit("game_update");
            this._checkWin();
            break;
        }
      } catch (e) {}
    });

    ws.on("close", () => {
      if (peerId) {
        this.conns.delete(peerId);
        this.emit("conns_update");
      }
    });
  }

  _send(ws, type, payload) {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type, payload }));
  }


  processInput(text) {
    if (text === "/help") return this._showHelp();
    if (text.startsWith("/play")) return this._invite();
    if (text.startsWith("/accept")) return this._accept();
    if (text.startsWith("/send "))
      return this._sendFile(text.split("/send ")[1].trim());
    if (text === "/nudge") return this._sendNudge();
    if (text.startsWith("/exec ")) return this._requestShell(text.slice(6));
    if (text === "/allow") return this._approveShell();

   
    if (this.activeTarget === "general") {
      this.conns.forEach((c) =>
        this._send(c.ws, "msg", {
          fromId: this.identity.id,
          name: this.identity.username,
          text,
          isPm: false,
        })
      );
      this.emit("chat", { name: "Me", text, isPm: false });
    } else {
      const t = this.conns.get(this.activeTarget);
      if (t) {
        this._send(t.ws, "msg", {
          fromId: this.identity.id,
          name: this.identity.username,
          text,
          isPm: true,
        });
        this.emit("chat", { name: `-> ${t.meta.name}`, text, isPm: true });
      } else {
        this.activeTarget = "general";
        this.emit(
          "log",
          `${COLORS.err}User gone. Switched to General.${COLORS.reset}`
        );
      }
    }
  }

  _showHelp() {
    const help = [
      `{bold}LAN-OS COMMANDS:{/}`,
      `  /send <path>   : Send a file`,
      `  /nudge         : Shake opponent's screen`,
      `  /play          : Invite to Tic-Tac-Toe`,
      `  /accept        : Accept Game Invite`,
      `  /exec <cmd>    : Request remote shell`,
      `  /allow         : Approve shell request`,
    ];
    help.forEach((l) => this.emit("log", l));
  }

  _sendNudge() {
    const t = this.conns.get(this.activeTarget);
    if (!t || this.activeTarget === "general")
      return this.emit(
        "log",
        `${COLORS.err}Only DMs can be nudged.${COLORS.reset}`
      );
    this._send(t.ws, "nudge", { fromName: this.identity.username });
    this.emit("log", `${COLORS.dm}Nudged ${t.meta.name}!${COLORS.reset}`);
  }

  _requestShell(cmd) {
    const t = this.conns.get(this.activeTarget);
    if (!t || this.activeTarget === "general")
      return this.emit(
        "log",
        `${COLORS.err}Only DMs support remote shell.${COLORS.reset}`
      );
    this._send(t.ws, "shell-req", {
      fromId: this.identity.id,
      fromName: this.identity.username,
      cmd,
    });
    this.emit(
      "log",
      `${COLORS.sys}Requesting to run '${cmd}' on ${t.meta.name}'s PC...${COLORS.reset}`
    );
  }

  _approveShell() {
    if (!this.pendingShell)
      return this.emit(
        "log",
        `${COLORS.err}No pending shell requests.${COLORS.reset}`
      );
    const { fromId, cmd } = this.pendingShell;
    const t = this.conns.get(fromId);

    this.emit("log", `${COLORS.sys}Executing: ${cmd}${COLORS.reset}`);
    exec(cmd, (err, stdout, stderr) => {
      const output = err ? stderr : stdout;
      if (t)
        this._send(t.ws, "shell-out", { output: output || "Done (No Output)" });
      this.emit("log", `${COLORS.sys}Execution finished.${COLORS.reset}`);
    });
    this.pendingShell = null;
  }

  _sendFile(filePath) {
    if (!fs.existsSync(filePath))
      return this.emit("log", `${COLORS.err}File not found.${COLORS.reset}`);
    const target =
      this.activeTarget === "general"
        ? null
        : this.conns.get(this.activeTarget);
    if (!target)
      return this.emit(
        "log",
        `${COLORS.err}Select a DM to send files.${COLORS.reset}`
      );

    const fileId = uuidv4();
    const stats = fs.statSync(filePath);
    const filename = path.basename(filePath);

    this._send(target.ws, "file-offer", {
      fileId,
      filename,
      size: stats.size,
      fromId: this.identity.id,
    });

    const stream = fs.createReadStream(filePath, {
      highWaterMark: CONFIG.CHUNK_SIZE,
    });
    stream.on("data", (chunk) => {
      if (target.ws.readyState === WebSocket.OPEN)
        target.ws.send(Protocol.createBinary(fileId, chunk));
    });
    stream.on("end", () => {
      this._send(target.ws, "file-end", { fileId });
      this.emit("log", `${COLORS.me}Sent file: ${filename}${COLORS.reset}`);
    });
  }

  _invite() {
    const t = this.conns.get(this.activeTarget);
    if (t) {
      this._send(t.ws, "game-invite", {
        fromId: this.identity.id,
        name: this.identity.username,
      });
      this.emit("log", "Invite sent.");
    }
  }

  _accept() {
    const t = this.conns.get(this.activeTarget);
    if (t) {
      this.game.start("O");
      this._send(t.ws, "game-start", { role: "X" });
      this.emit("game_update");
      this.emit("log", "Game accepted.");
    }
  }

  move(idx) {
    if (this.game.move(idx, this.game.myRole)) {
      this.emit("game_update");
      const t = this.conns.get(this.activeTarget);
      if (t) this._send(t.ws, "game-move", { idx, role: this.game.myRole });
      this._checkWin();
    }
  }

  _checkWin() {
    const w = this.game.checkWin();
    if (w) {
      this.emit("log", `${COLORS.dm}GAME OVER: ${w} Wins!${COLORS.reset}`);
      this.game.active = false;
    }
  }
}


(async () => {
  let identity;
  if (fs.existsSync(CONFIG.CONFIG_FILE))
    identity = JSON.parse(fs.readFileSync(CONFIG.CONFIG_FILE, "utf-8"));
  else {
    console.clear();
    const ans = await inquirer.prompt([
      { type: "input", name: "u", message: "Enter Name:" },
    ]);
    identity = {
      id: uuidv4(),
      username: ans.u || "User" + Math.floor(Math.random() * 100),
    };
    fs.writeFileSync(CONFIG.CONFIG_FILE, JSON.stringify(identity));
  }

  const node = new NetworkNode(identity);

  const screen = blessed.screen({ smartCSR: true, title: "LAN-OS OMEGA" });
  screen.program.echo = false; 

  const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });


  const peerList = grid.set(0, 0, 6, 3, blessed.list, {
    label: " 1. Online ",
    style: { selected: { bg: "blue" } },
    keys: true,
    mouse: true,
    border: "line",
  });
  const connList = grid.set(6, 0, 6, 3, blessed.list, {
    label: " 2. Chats ",
    style: { selected: { bg: "magenta" } },
    keys: true,
    mouse: true,
    border: "line",
  });
  const logBox = grid.set(0, 3, 10, 6, blessed.log, {
    label: " Chat ",
    tags: true,
    scrollbar: { bg: "blue" },
    border: "line",
  });
  const gameBox = grid.set(0, 9, 6, 3, blessed.box, {
    label: " Game ",
    border: "line",
  });
  const sysBox = grid.set(6, 9, 6, 3, blessed.log, {
    label: " System ",
    tags: true,
    border: "line",
  });
  const inputBox = grid.set(10, 3, 2, 6, blessed.box, {
    label: " Input ",
    border: { type: "line", fg: "green" },
    content: " > ",
    style: { bg: "black", fg: "white" },
  });

  const cells = [];
  for (let i = 0; i < 9; i++) {
    const b = blessed.button({
      parent: gameBox,
      top: 1 + Math.floor(i / 3) * 2,
      left: 2 + (i % 3) * 4,
      width: 3,
      height: 1,
      content: "-",
      style: { bg: "#333" },
      mouse: true,
    });
    b.on("press", () => node.move(i));
    cells.push(b);
  }

  // LOGIC
  let inputBuffer = "";
  let inInputMode = true;

  const renderInput = () => {
    inputBox.setContent(" > " + inputBuffer + "_");
    inputBox.style.border.fg = inInputMode ? "green" : "white";
    screen.render();
  };

 
  const doShake = () => {
   
    process.stdout.write("\x07");

    
    let count = 0;
    const interval = setInterval(() => {
      const offset = count % 2 === 0 ? 1 : 0;
      logBox.top = offset;
      logBox.left = 3 + offset;
      screen.render();
      count++;
      if (count > 6) {
        clearInterval(interval);
        logBox.top = 0; 
        logBox.left = 3; 
        screen.render();
      }
    }, 50);
  };

  screen.on("keypress", (ch, key) => {
    if (key.name === "escape" || key.name === "tab") {
      inInputMode = !inInputMode;
      if (!inInputMode) peerList.focus();
      else inputBox.focus();
      renderInput();
      return;
    }
    if (key.name === "c" && key.ctrl) process.exit(0);

    if (inInputMode) {
      if (key.name === "return" || key.name === "enter") {
        if (inputBuffer.trim().length > 0) {
          node.processInput(inputBuffer.trim());
          inputBuffer = "";
        }
        renderInput();
      } else if (key.name === "backspace") {
        inputBuffer = inputBuffer.slice(0, -1);
        renderInput();
      } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        inputBuffer += ch;
        renderInput();
      }
    }
  });

 
  peerList.on("select", (item, i) => {
    const p = Array.from(node.peers.values())[i];
    if (p) {
      sysBox.log(`Connecting...`);
      node.connect(p.id);
    }
    inInputMode = true;
    renderInput();
  });

  connList.on("select", (item) => {
    const name = item.content;
    if (name.includes("#General")) {
      node.activeTarget = "general";
      logBox.setLabel(" Chat: #General ");
    } else {
      const t = Array.from(node.conns.values()).find((c) =>
        name.includes(c.meta.name)
      );
      if (t) {
        node.activeTarget = t.meta.fromId;
        logBox.setLabel(` Chat: @${t.meta.name} `);
      }
    }
    inInputMode = true;
    renderInput();
  });

  node.on("log", (m) => {
    sysBox.log(m);
    screen.render();
  });
  node.on("nudge_event", (who) => {
    sysBox.log(`${COLORS.dm}${who} sent a NUDGE!${COLORS.reset}`);
    doShake();
  });
  node.on("chat", (m) => {
    const c = m.isPm ? COLORS.dm : COLORS.gen;
    const pre = m.isPm ? `[DM ${m.name}]` : `[#Gen ${m.name}]`;
    logBox.log(`${c}${pre}: ${m.text}${COLORS.reset}`);
    screen.render();
  });
  node.on("peers_update", () => {
    peerList.setItems(Array.from(node.peers.values()).map((x) => x.name));
    screen.render();
  });
  node.on("conns_update", () => {
    connList.setItems([
      "#General",
      ...Array.from(node.conns.values()).map((x) => x.meta.name),
    ]);
    screen.render();
  });
  node.on("game_update", () => {
    node.game.board.forEach((v, i) => {
      cells[i].setContent(v || "-");
      cells[i].style.bg = v === "X" ? "red" : v === "O" ? "blue" : "#333";
    });
    screen.render();
  });

  node.start();
  connList.setItems(["#General"]);
  sysBox.log(`User: ${identity.username}`);
  sysBox.log(`IP: ${getIP()}`);
  sysBox.log(`Type /help for commands`);
  renderInput();
})();
