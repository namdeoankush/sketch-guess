# Sketch & Guess

A real-time multiplayer word-guessing drawing game (skribbl.io-style) built with
Node.js, Express, Socket.io, and vanilla HTML5 Canvas/JS. No frontend framework,
no build step, no dependencies beyond `express` and `socket.io`.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000` in multiple browser tabs/devices to play.

## Project layout

```
server.js          Express + Socket.io server: rooms, turn rotation, timers,
                    word-bank management, scoring, chat/guess validation.
public/index.html   Entry / lobby / game screen markup.
public/style.css    Dark, modern 3-column grid layout (leaderboard | canvas | chat).
public/app.js       Client: screen routing, canvas drawing + sync, chat, timers.
```

## How it works

- **Lobby**: enter a name, then either create a room (optionally supplying a
  comma-separated custom word list — falls back to a built-in list if fewer
  than 3 words are given) or join one with a 5-character room code.
- **Start**: only the room owner can start, and only once 2+ players are in.
- **Turns**: player order is shuffled once at game start, then rotates
  sequentially, looping back to the front as needed, until the word bank is
  empty.
- **Word choice**: each drawer is offered up to 3 random remaining words
  (12s to choose, otherwise the first option is auto-picked). The chosen
  word is permanently removed from the room's word bank — it can never
  reappear.
- **Drawing phase**: 30 seconds. Drawer's strokes stream to everyone else via
  `drawStep`/`clearCanvas` socket events; non-drawers' canvases are locked.
- **Guessing**: non-drawers guess in chat. An exact, case-insensitive match
  awards the guesser `max(timeLeft * 3, 10)` points and the drawer a flat
  +15 bonus, and is announced to the room without leaking the actual word.
  Drawers cannot chat during their own turn. The round ends early once every
  connected non-drawer has guessed correctly.
- **Round end**: the word is revealed for 4 seconds, then the next turn
  begins automatically.
- **Game end**: once the word bank is exhausted, final scores are shown.

## Notes / known simplifications

- Rooms live in memory only (a `Map`), so a server restart clears all games —
  fine for a single-process deployment; swap in Redis/a DB if you need
  persistence or horizontal scaling across multiple server instances.
- Player identity is tied to the socket connection; a page refresh mid-game
  rejoins as a new player rather than resuming your previous slot.
# sketch-guess