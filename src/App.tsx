import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

type Player = "p1" | "p2";
type Winner = Player | "tie" | null;

type ChatMessage = {
  roomCode: string;
  from: string;
  text: string;
  timestamp: number;
};

type ServerState = {
  rematchReady?: { self: boolean; opponent: boolean };
  roomCode: string;
  currentTurn: Player;
  winner: Winner;

  called: number[];
  lastCalled: number | null;

  grid: number[];
  markedCells: boolean[];

  self: { name: string | null; score: number };
  opponent: { name: string | null; score: number };
};

type RoomCreated = { roomCode: string; player: Player };
type RoomJoined = { player: Player };
type ErrorEvent = { message: string };

const N = 5;

export default function App() {
  const apiUrl = import.meta.env.VITE_API_URL as string;

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");

  const socket = useMemo(() => io(apiUrl, { autoConnect: false }), [apiUrl]);

  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState<string | null>(null);

  const [player, setPlayer] = useState<Player | null>(null);

  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomCodeShown, setRoomCodeShown] = useState<string | null>(null);

  const [name, setName] = useState<string>("");

  const [state, setState] = useState<ServerState | null>(null);

  // track current room code for chat filtering (prevents stale closure)
  const roomCodeRef = useRef<string | null>(null);

  // Animation: track which cells newly became marked
  const prevMarkedRef = useRef<boolean[] | null>(null);
  const [animatingCells, setAnimatingCells] = useState<Set<number>>(
    () => new Set(),
  );

  useEffect(() => {
    socket.connect();

    socket.on("CHAT_RECEIVED", (msg: ChatMessage) => {
      const currentRoom = roomCodeRef.current;
      if (!currentRoom) return;
      if (msg.roomCode !== currentRoom) return;

      setChatMessages((prev) => [...prev, msg]);
    });

    socket.on("ROOM_CREATED", (data: RoomCreated) => {
      setPlayer(data.player);
      setRoomCodeShown(data.roomCode);
      setStatus("Room created. Waiting for other player…");

      // reset chat only when creating a new room
      setChatMessages([]);
    });

    socket.on("ROOM_JOINED", (_data: RoomJoined) => {
      setPlayer(_data.player);
      setStatus("Joined room.");

      // reset chat only when joining a new room
      setChatMessages([]);
    });

    socket.on("GAME_STATE_UPDATED", (newState: ServerState) => {
      // ---- compute newly marked cells for animation ----
      const prev = prevMarkedRef.current;
      const currMarked = newState.markedCells;

      if (prev) {
        const newlyMarked = new Set<number>();
        for (let i = 0; i < currMarked.length; i++) {
          if (currMarked[i] && !prev[i]) newlyMarked.add(i);
        }

        if (newlyMarked.size > 0) {
          setAnimatingCells((prevSet) => {
            const merged = new Set(prevSet);
            for (const idx of newlyMarked) merged.add(idx);
            return merged;
          });

          setTimeout(() => {
            setAnimatingCells((setNow) => {
              const next = new Set(setNow);
              for (const idx of newlyMarked) next.delete(idx);
              return next;
            });
          }, 450);
        }
      }

      prevMarkedRef.current = currMarked;

      setState(newState);
      setError(null);
      setRoomCodeShown(newState.roomCode);

      // keep room code ref in sync so chat doesn't rely on stale state closure
      roomCodeRef.current = newState.roomCode;

      if (newState.winner) {
        if (newState.winner === "tie") setStatus("It's a tie!");
        else setStatus(`Winner: ${newState.winner.toUpperCase()}`);
      } else {
        setStatus(newState.currentTurn === "p1" ? "P1 turn" : "P2 turn");
      }
    });

    socket.on("ERROR", (e: ErrorEvent) => {
      setError(e.message);
      setStatus("Error");
    });

    socket.on("connect_error", (e: any) => {
      setError(String(e?.message ?? e));
      setStatus("Socket connect error");
    });

    return () => {
      socket.off();
      socket.disconnect();
    };
  }, [socket]);

  function createRoom() {
    setError(null);
    const trimmed = name.trim();
    socket.emit("CREATE_ROOM", { name: trimmed ? trimmed : undefined });
  }

  function joinRoom() {
    setError(null);
    const code = roomCodeInput.trim();
    if (!code) return;

    const trimmed = name.trim();
    socket.emit("JOIN_ROOM", {
      roomCode: code,
      name: trimmed ? trimmed : undefined,
    });
  }

  const calledSet = useMemo(
    () => new Set(state?.called ?? []),
    [state?.called],
  );

  function displayName(p: "self" | "opponent"): string {
    if (!state) return p.toUpperCase();
    if (p === "self") return (state.self.name ?? "YOU").trim() || "YOU";
    return (state.opponent.name ?? "OPPONENT").trim() || "OPPONENT";
  }

  const isMyTurn = state && player ? state.currentTurn === player : false;
  const winner = state?.winner;

  return (
    <div className='container'>
      <h1>Bingo Grid</h1>

      <div className='panel'>
        <div>Status: {status}</div>
        {error && <div className='error'>{error}</div>}

        {!player && (
          <div className='roomRow'>
            <div className='join'>
              <input
                placeholder='Room code'
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value)}
              />
              <button onClick={joinRoom}>Join</button>
            </div>

            <div className='join'>
              <input
                placeholder='Your name'
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <button onClick={createRoom}>Create Room</button>
          </div>
        )}

        {player && state && (
          <>
            <div className='roomCodeRow'>
              <div className='roomCode'>
                Room code: <b>{roomCodeShown ?? state.roomCode}</b>
              </div>

              <button
                className='iconBtn'
                title='Copy room code'
                aria-label='Copy room code'
                onClick={async () => {
                  const code = roomCodeShown ?? state.roomCode;
                  try {
                    await navigator.clipboard.writeText(code);
                  } catch {
                    // ignore
                  }
                }}
              >
                {/* copy icon */}
                <svg
                  width='18'
                  height='18'
                  viewBox='0 0 24 24'
                  fill='none'
                  aria-hidden='true'
                >
                  <path
                    d='M8 7.5V6.6C8 5.716 8.716 5 9.6 5H18.4C19.284 5 20 5.716 20 6.6V15.4C20 16.284 19.284 17 18.4 17H17.5'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                  />
                  <path
                    d='M6.6 7H15.4C16.284 7 17 7.716 17 8.6V17.4C17 18.284 16.284 19 15.4 19H6.6C5.716 19 5 18.284 5 17.4V8.6C5 7.716 5.716 7 6.6 7Z'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinejoin='round'
                  />
                </svg>
              </button>
            </div>

            <div className='scores'>
              <div className={state.currentTurn === player ? "turn" : ""}>
                {displayName("self")}: {state.self.score}
              </div>
              <div className={state.currentTurn !== player ? "turn" : ""}>
                {displayName("opponent")}: {state.opponent.score}
              </div>
            </div>

            {/* Winner / rematch */}
            {winner && (
              <>
                {winner === "tie" ? (
                  <div className='winner'>🤝 It's a tie!</div>
                ) : winner === player ? (
                  <div className='winner'>🏆 You win!</div>
                ) : (
                  <div className='winner'>
                    🏆 {displayName("opponent")} wins!
                  </div>
                )}

                <div className='rematchWrap'>
                  <button
                    className='rematchBtn'
                    onClick={() => {
                      socket.emit("REMATCH_READY", {
                        roomCode: state.roomCode,
                      });
                    }}
                    disabled={state.rematchReady?.self === true}
                  >
                    {state.rematchReady?.self ? "Rematch ready ✅" : "Rematch"}
                  </button>

                  <div className='rematchStatus'>
                    {state.rematchReady
                      ? state.rematchReady.opponent
                        ? "Opponent is ready ✅"
                        : "Waiting for opponent…"
                      : "Waiting…"}
                  </div>
                </div>
              </>
            )}

            {/* Called */}
            <div className='calledWrap'>
              <div className='calledTitle'>Number called:</div>
              <div className='calledList'>
                {state.lastCalled == null ? "None yet" : state.lastCalled}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Grid */}
      {state && (
        <div className='grid' role='grid' aria-label='Your Bingo grid'>
          {Array.from({ length: 25 }, (_, idx) => {
            const value = state.grid[idx];
            const isMarked = state.markedCells[idx];

            const disabled =
              !isMyTurn || !!winner || isMarked || calledSet.has(value);

            const isAnimating = animatingCells.has(idx);

            return (
              <button
                key={idx}
                className={`cell ${isMarked ? "marked" : ""} ${
                  disabled ? "disabled" : ""
                } ${isAnimating ? "call-anim" : ""}`}
                disabled={disabled}
                onClick={() => {
                  if (!isMyTurn || !player || winner) return;
                  if (calledSet.has(value)) return;

                  socket.emit("CALL_NUMBER", {
                    roomCode: state.roomCode,
                    number: value,
                  });
                }}
                aria-label={`Cell ${Math.floor(idx / N) + 1},${
                  (idx % N) + 1
                }: ${value}${isMarked ? " marked" : ""}`}
              >
                {value}
              </button>
            );
          })}
        </div>
      )}

      {/* Chat */}
      {player && state && (
        <div className='chatWrap'>
          <div className='chatTitle'>Chat</div>

          <div className='chatMessages' role='log' aria-label='Chat messages'>
            {chatMessages.length === 0 ? (
              <div className='chatEmpty'>Say hi 👋</div>
            ) : (
              chatMessages.map((m, i) => (
                <div key={`${m.timestamp}-${i}`} className='chatMsg'>
                  <span className='chatFrom'>{m.from}:</span>{" "}
                  <span className='chatText'>{m.text}</span>
                </div>
              ))
            )}
          </div>

          <div className='chatInputRow'>
            <input
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder='Type a message…'
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  socket.emit("CHAT_SEND", {
                    roomCode: state.roomCode,
                    text: chatText,
                  });
                  setChatText("");
                }
              }}
            />
            <button
              onClick={() => {
                socket.emit("CHAT_SEND", {
                  roomCode: state.roomCode,
                  text: chatText,
                });
                setChatText("");
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
