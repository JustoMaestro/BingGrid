import express from "express";
import cors from "cors";
import http from "http";
import { Server, Socket } from "socket.io";

type Player = "p1" | "p2";
type Winner = Player | "tie" | null;

const N = 5;
const SIZE = N * N; // 25
const WIN_SCORE = 5;

const app = express();
app.use(cors({ origin: "*" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// ---- Lines (12 total): 5 rows + 5 cols + 2 diagonals ("X") ----
const LINES: number[][] = (() => {
  const lines: number[][] = [];

  // rows
  for (let r = 0; r < N; r++) {
    lines.push(Array.from({ length: N }, (_, c) => r * N + c));
  }

  // cols
  for (let c = 0; c < N; c++) {
    lines.push(Array.from({ length: N }, (_, r) => r * N + c));
  }

  // diagonals
  lines.push([0, 6, 12, 18, 24]); // TL -> BR
  lines.push([4, 8, 12, 16, 20]); // TR -> BL

  return lines;
})();

function otherPlayer(p: Player): Player {
  return p === "p1" ? "p2" : "p1";
}

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeGrid(): number[] {
  // each player's grid is a random permutation of 1..25
  return shuffle(Array.from({ length: SIZE }, (_, i) => i + 1));
}

function markedForGrid(grid: number[], called: Set<number>): boolean[] {
  // marked if that cell's value has been called
  return grid.map((v) => called.has(v));
}

function newlyCompletedLines(args: {
  marked: boolean[];
  completedLineIds: Set<number>;
}): number[] {
  const { marked, completedLineIds } = args;
  const newly: number[] = [];

  for (let lineId = 0; lineId < LINES.length; lineId++) {
    if (completedLineIds.has(lineId)) continue;
    const cells = LINES[lineId];
    if (cells.every((idx) => marked[idx])) newly.push(lineId);
  }

  return newly;
}

// ---- Room state ----
type PlayerState = {
  grid: number[];
  // per-player: remember which lines have already scored for that player
  completedLineIds: Set<number>;
  score: number;
  name: string | null;
};

type GameState = {
  roomCode: string;
  lastCalled: number | null;

  p1: PlayerState;
  p2: PlayerState;

  called: Set<number>; // shared called numbers

  currentTurn: Player;
  winner: Winner;

  playerSocketId: Record<Player, string | null>;

  // Rematch handshake
  rematchReady: Record<Player, boolean>;
};

const rooms = new Map<string, GameState>();

function makeRoomCode(): string {
  // avoid confusing chars
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++)
    s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function getPlayerForSocket(state: GameState, socket: Socket): Player | null {
  if (socket.id === state.playerSocketId.p1) return "p1";
  if (socket.id === state.playerSocketId.p2) return "p2";
  return null;
}

function randomFirst(): Player {
  return Math.random() < 0.5 ? "p1" : "p2";
}

// Personalized serialization: opponent grid never sent
function serializeForPlayer(state: GameState, player: Player) {
  const self = player === "p1" ? state.p1 : state.p2;
  const opp = player === "p1" ? state.p2 : state.p1;

  const selfMarked = markedForGrid(self.grid, state.called);

  return {
    roomCode: state.roomCode,
    currentTurn: state.currentTurn,
    winner: state.winner,

    // called list shown (counts can be reduced in the UI later)
    called: [...state.called],
    lastCalled: state.lastCalled,

    // only your grid+marks
    grid: self.grid,
    markedCells: selfMarked,

    self: { name: self.name, score: self.score },
    opponent: { name: opp.name, score: opp.score },

    rematchReady: {
      self: state.rematchReady[player],
      opponent: state.rematchReady[otherPlayer(player)],
    },
  };
}

function emitRoomState(state: GameState) {
  if (state.playerSocketId.p1) {
    io.to(state.playerSocketId.p1).emit(
      "GAME_STATE_UPDATED",
      serializeForPlayer(state, "p1"),
    );
  }
  if (state.playerSocketId.p2) {
    io.to(state.playerSocketId.p2).emit(
      "GAME_STATE_UPDATED",
      serializeForPlayer(state, "p2"),
    );
  }
}

function startNewRound(state: GameState) {
  state.called = new Set<number>();
  state.winner = null;
  state.currentTurn = randomFirst();

  state.p1.grid = makeGrid();
  state.p2.grid = makeGrid();

  state.p1.completedLineIds = new Set<number>();
  state.p2.completedLineIds = new Set<number>();

  state.p1.score = 0;
  state.p2.score = 0;

  state.rematchReady = { p1: false, p2: false };
}

// ---- Socket events ----
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("CREATE_ROOM", ({ name }: { name?: string } = {}) => {
    const roomCode = makeRoomCode();

    const state: GameState = {
      lastCalled: null,
      roomCode,
      called: new Set<number>(),
      currentTurn: randomFirst(),
      winner: null,
      playerSocketId: { p1: socket.id, p2: null },

      rematchReady: { p1: false, p2: false },

      p1: {
        grid: makeGrid(),
        completedLineIds: new Set<number>(),
        score: 0,
        name: name?.trim() ? name.trim() : null,
      },
      p2: {
        grid: makeGrid(),
        completedLineIds: new Set<number>(),
        score: 0,
        name: null,
      },
    };

    rooms.set(roomCode, state);

    socket.join(roomCode);
    socket.emit("ROOM_CREATED", { roomCode, player: "p1" });
    socket.emit("GAME_STATE_UPDATED", serializeForPlayer(state, "p1"));

    console.log("ROOM_CREATED:", roomCode, "for", socket.id);
  });

  socket.on(
    "JOIN_ROOM",
    ({ roomCode, name }: { roomCode: string; name?: string }) => {
      const state = rooms.get(roomCode);
      if (!state) {
        socket.emit("ERROR", { message: "Room not found" });
        return;
      }

      if (state.playerSocketId.p2 && state.playerSocketId.p2 !== socket.id) {
        socket.emit("ERROR", { message: "Room is full" });
        return;
      }

      state.playerSocketId.p2 = socket.id;
      state.p2.name = name?.trim() ? name.trim() : state.p2.name;

      socket.join(roomCode);

      socket.emit("ROOM_JOINED", { player: "p2" });
      emitRoomState(state);

      console.log("ROOM_JOINED:", roomCode, "player p2", socket.id);
    },
  );

  socket.on(
    "CALL_NUMBER",
    ({ roomCode, number }: { roomCode: string; number: number }) => {
      const state = rooms.get(roomCode);
      if (!state) return;

      if (state.winner) {
        socket.emit("ERROR", { message: "Game already finished" });
        return;
      }

      const player = getPlayerForSocket(state, socket);
      if (!player) return;

      if (state.currentTurn !== player) {
        socket.emit("ERROR", { message: "Not your turn" });
        return;
      }

      if (typeof number !== "number" || number < 1 || number > 25) {
        socket.emit("ERROR", { message: "Invalid number" });
        return;
      }

      if (state.called.has(number)) {
        socket.emit("ERROR", { message: "Number already called" });
        return;
      }

      // Apply shared call
      state.called.add(number);

      state.lastCalled = number;

      // Mark for BOTH players, score BOTH players if their grids newly complete lines
      const markedP1 = markedForGrid(state.p1.grid, state.called);
      const markedP2 = markedForGrid(state.p2.grid, state.called);

      const newlyP1 = newlyCompletedLines({
        marked: markedP1,
        completedLineIds: state.p1.completedLineIds,
      });

      const newlyP2 = newlyCompletedLines({
        marked: markedP2,
        completedLineIds: state.p2.completedLineIds,
      });

      for (const lineId of newlyP1) state.p1.completedLineIds.add(lineId);
      for (const lineId of newlyP2) state.p2.completedLineIds.add(lineId);

      if (newlyP1.length > 0) state.p1.score += newlyP1.length;
      if (newlyP2.length > 0) state.p2.score += newlyP2.length;

      // Win/tie check
      const p1Reached = state.p1.score >= WIN_SCORE;
      const p2Reached = state.p2.score >= WIN_SCORE;

      if (p1Reached && p2Reached) {
        state.winner = "tie";
      } else if (p1Reached) {
        state.winner = "p1";
      } else if (p2Reached) {
        state.winner = "p2";
      } else {
        // only alternate turn if nobody won/tied
        state.currentTurn = otherPlayer(player);
      }

      emitRoomState(state);
    },
  );

  socket.on("REMATCH_READY", ({ roomCode }: { roomCode: string }) => {
    const state = rooms.get(roomCode);
    if (!state) return;

    const player = getPlayerForSocket(state, socket);
    if (!player) return;

    // rematch only makes sense after round finished
    if (!state.winner) return;

    state.rematchReady[player] = true;

    if (state.rematchReady.p1 && state.rematchReady.p2) {
      startNewRound(state);
    }

    emitRoomState(state);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

server.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
