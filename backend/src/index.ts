import express from "express";
import cors from "cors";
import http from "http";
import { Server, Socket } from "socket.io";

type Player = "p1" | "p2";
const N = 5;
const SIZE = N * N; // 25
const WIN_SCORE = 5;

const app = express();
app.use(cors({ origin: "*" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

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
  // diagonals (X)
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
  return shuffle(Array.from({ length: SIZE }, (_, i) => i + 1)); // 1..25
}

function markedForGrid(grid: number[], called: Set<number>) {
  return grid.map((v) => called.has(v)); // cell is marked if its number is called
}

function newlyCompletedLines(args: {
  marked: boolean[];
  completedLineIds: Set<number>;
}) {
  const { marked, completedLineIds } = args;
  const newly: number[] = [];

  for (let lineId = 0; lineId < LINES.length; lineId++) {
    if (completedLineIds.has(lineId)) continue;
    const cells = LINES[lineId];
    if (cells.every((idx) => marked[idx])) newly.push(lineId);
  }
  return newly;
}

function makeRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++)
    s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

type PlayerState = {
  grid: number[]; // length 25
  completedLineIds: Set<number>; // lines already scored for THAT player’s grid
  score: number;
  name: string | null;
};

type GameState = {
  roomCode: string;

  p1: PlayerState;
  p2: PlayerState;

  called: Set<number>; // shared across room

  currentTurn: Player;
  winner: Player | null;

  playerSocketId: Record<Player, string | null>;

  rematchReady: Record<Player, boolean>;
};

const rooms = new Map<string, GameState>();

function getPlayerForSocket(state: GameState, socket: Socket): Player | null {
  if (socket.id === state.playerSocketId.p1) return "p1";
  if (socket.id === state.playerSocketId.p2) return "p2";
  return null;
}

// IMPORTANT: personalized serialization — only send each player their own grid/marks
function serializeForPlayer(state: GameState, player: Player) {
  const self = player === "p1" ? state.p1 : state.p2;
  const opp = player === "p1" ? state.p2 : state.p1;

  return {
    rematchReady: {
      self: state.rematchReady[player],
      opponent: state.rematchReady[player === "p1" ? "p2" : "p1"],
    },

    roomCode: state.roomCode,
    currentTurn: state.currentTurn,
    winner: state.winner,

    called: [...state.called],

    // only your board
    grid: self.grid,
    markedCells: markedForGrid(self.grid, state.called),

    // names/scores (opponent info is OK; grid is not)
    self: { name: self.name, score: self.score },
    opponent: { name: opp.name, score: opp.score },
  };
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("REMATCH_READY", ({ roomCode }: { roomCode: string }) => {
    const state = rooms.get(roomCode);
    if (!state) return;
    if (!state.winner) return; // only allow after someone wins (optional)

    const player = getPlayerForSocket(state, socket);
    if (!player) return;

    // mark who is ready
    state.rematchReady[player] = true;

    // if both ready, start a new round
    if (state.rematchReady.p1 && state.rematchReady.p2) {
      state.called = new Set<number>();
      state.winner = null;
      state.currentTurn = "p1";

      state.p1.grid = makeGrid();
      state.p2.grid = makeGrid();

      state.p1.completedLineIds = new Set<number>();
      state.p2.completedLineIds = new Set<number>();

      state.p1.score = 0;
      state.p2.score = 0;

      state.rematchReady = { p1: false, p2: false };
    }

    // emit personalized updates
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
  });

  socket.on("CREATE_ROOM", ({ name }: { name?: string }) => {
    const roomCode = makeRoomCode();

    const state: GameState = {
      rematchReady: { p1: false, p2: false },
      roomCode,
      called: new Set<number>(),
      currentTurn: "p1",
      winner: null,
      playerSocketId: { p1: socket.id, p2: null },

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

    console.log("ROOM_CREATED:", roomCode, "for", socket.id, "p1");
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

      // personalized send to both players
      if (state.playerSocketId.p1) {
        io.to(state.playerSocketId.p1).emit(
          "GAME_STATE_UPDATED",
          serializeForPlayer(state, "p1"),
        );
      }
      io.to(state.playerSocketId.p2!).emit(
        "GAME_STATE_UPDATED",
        serializeForPlayer(state, "p2"),
      );

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

      // Apply move
      state.called.add(number);

      // Score for THIS player's own grid
      const selfState = player === "p1" ? state.p1 : state.p2;
      const marked = markedForGrid(selfState.grid, state.called);

      const newly = newlyCompletedLines({
        marked,
        completedLineIds: selfState.completedLineIds,
      });

      for (const lineId of newly) selfState.completedLineIds.add(lineId);
      if (newly.length > 0) selfState.score += newly.length;

      // Win check
      if (selfState.score >= WIN_SCORE) {
        state.winner = player;
      } else {
        state.currentTurn = otherPlayer(player);
      }

      // Emit personalized updates (opponent grid never leaves server)
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
    },
  );

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
