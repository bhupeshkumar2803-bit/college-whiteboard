
import { useEffect, useRef, useState } from "react";
import {
  Canvas, PencilBrush, Rect, Circle, IText, Line
} from "fabric";

import {
  MousePointer2, Pencil, Eraser, Type, Square,
  Circle as CircleIcon, StickyNote, Minus, Undo2,
  Redo2, Trash2, Download, Save, Users, PlusCircle
} from "lucide-react";

import { supabase } from "./lib/supabaseClient";
import "./App.css";

export default function App() {
  const canvasElement = useRef(null);
  const canvasRef = useRef(null);
  const history = useRef([]);
  const historyIndex = useRef(-1);
  const channelRef = useRef(null);
  const activeRoom = useRef(null);
  const syncTimer = useRef(null);
  const applyingRemote = useRef(false);

  const [tool, setTool] = useState("select");
  const [color, setColor] = useState("#20242b");
  const [size, setSize] = useState(4);
  const [boardName, setBoardName] = useState("My Whiteboard");
  const [status, setStatus] = useState("Ready");
  const [roomId, setRoomId] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [roomStatus, setRoomStatus] = useState("Not connected");

  // Save canvas history for undo and redo
  function saveHistory() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const data = JSON.stringify(canvas.toJSON());

    if (history.current[historyIndex.current] === data) return;

    history.current = history.current.slice(
      0,
      historyIndex.current + 1
    );

    history.current.push(data);

    if (history.current.length > 40) {
      history.current.shift();
    }

    historyIndex.current = history.current.length - 1;
  }

  // Apply a board received from another member
  async function applyRemoteBoard(data) {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    try {
      applyingRemote.current = true;

      await canvas.loadFromJSON(data);
      canvas.renderAll();

      saveHistory();
      setStatus("Received a live board update");
    } catch (error) {
      console.error("Could not load remote board:", error);
    } finally {
      applyingRemote.current = false;
    }
  }

  // Save the current board to Supabase and notify other members
  async function syncBoard() {
    const canvas = canvasRef.current;
    const id = activeRoom.current;

    if (!canvas || !id || applyingRemote.current) return;

    const boardData = canvas.toJSON();

    const { error } = await supabase
      .from("whiteboard_rooms")
      .upsert({
        room_id: id,
        board_data: boardData,
        updated_at: new Date().toISOString()
      });

    if (error) {
      console.error("Board sync error:", error);
      setRoomStatus("Sync failed");
      return;
    }

    channelRef.current?.send({
      type: "broadcast",
      event: "board-update",
      payload: { boardData }
    });

    localStorage.setItem(
      "my-whiteboard",
      JSON.stringify(boardData)
    );

    setRoomStatus("Connected - changes saved");
  }

  // Delay synchronization slightly to avoid sending every mouse movement
  function scheduleSync() {
    if (!activeRoom.current || applyingRemote.current) return;

    clearTimeout(syncTimer.current);

    syncTimer.current = setTimeout(() => {
      syncBoard();
    }, 400);
  }

  // Initialize Fabric canvas
  useEffect(() => {
    const canvas = new Canvas(canvasElement.current, {
      width: 1100,
      height: 700,
      backgroundColor: "#ffffff",
      selection: true,
      preserveObjectStacking: true
    });

    canvasRef.current = canvas;

    canvas.freeDrawingBrush = new PencilBrush(canvas);
    canvas.freeDrawingBrush.color = color;
    canvas.freeDrawingBrush.width = size;

    const recordChange = () => {
      if (applyingRemote.current) return;

      saveHistory();
      scheduleSync();
    };

    canvas.on("object:added", recordChange);
    canvas.on("object:modified", recordChange);
    canvas.on("object:removed", recordChange);
    canvas.on("path:created", recordChange);

    const saved = localStorage.getItem("my-whiteboard");

    if (saved) {
      try {
        canvas.loadFromJSON(JSON.parse(saved)).then(() => {
          canvas.renderAll();
          saveHistory();
        });
      } catch {
        saveHistory();
      }
    } else {
      saveHistory();
    }

    return () => {
      clearTimeout(syncTimer.current);
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      canvas.dispose();
      canvasRef.current = null;
    };
  }, []);

  // Change drawing tool and brush settings
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.isDrawingMode = tool === "pen" || tool === "eraser";
    canvas.selection = tool === "select";

    if (tool === "pen" || tool === "eraser") {
      canvas.freeDrawingBrush.color =
        tool === "eraser" ? "#ffffff" : color;

      canvas.freeDrawingBrush.width =
        tool === "eraser" ? size * 5 : size;
    }

    canvas.defaultCursor =
      tool === "select" ? "default" : "crosshair";
  }, [tool, color, size]);

  // Connect to a shared room
  async function connectToRoom(id) {
    if (channelRef.current) {
      await supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    activeRoom.current = id;
    setRoomId(id);
    setRoomInput(id);
    setRoomStatus("Connecting...");

    const channel = supabase
      .channel(`whiteboard-${id}`, {
        config: {
          broadcast: { self: false }
        }
      })
      .on(
        "broadcast",
        { event: "board-update" },
        ({ payload }) => {
          if (payload?.boardData) {
            applyRemoteBoard(payload.boardData);
          }
        }
      )
      .subscribe(async (channelStatus) => {
        if (channelStatus === "SUBSCRIBED") {
          const { data, error } = await supabase
            .from("whiteboard_rooms")
            .select("board_data")
            .eq("room_id", id)
            .maybeSingle();

          if (error) {
            console.error(error);
            setRoomStatus("Could not load room");
            return;
          }

          if (data?.board_data) {
            await applyRemoteBoard(data.board_data);
          }

          setRoomStatus("Connected - ready to collaborate");
        }

        if (channelStatus === "CHANNEL_ERROR") {
          setRoomStatus("Connection error");
        }

        if (channelStatus === "TIMED_OUT") {
          setRoomStatus("Connection timed out");
        }
      });

    channelRef.current = channel;
  }

  // Create a new room
  async function createRoom() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const id =
      "WB-" + Math.random().toString(36).slice(2, 8).toUpperCase();

    const { error } = await supabase
      .from("whiteboard_rooms")
      .insert({
        room_id: id,
        board_data: canvas.toJSON()
      });

    if (error) {
      console.error(error);
      setRoomStatus("Could not create room");
      return;
    }

    await connectToRoom(id);
    setStatus("New shared room created");
  }

  // Join an existing room
  async function joinRoom() {
    const id = roomInput.trim().toUpperCase();

    if (!id) {
      alert("Please enter a Room ID");
      return;
    }

    const { data, error } = await supabase
      .from("whiteboard_rooms")
      .select("room_id")
      .eq("room_id", id)
      .maybeSingle();

    if (error) {
      console.error(error);
      setRoomStatus("Could not check room");
      return;
    }

    if (!data) {
      alert("Room not found. Check the Room ID.");
      return;
    }

    await connectToRoom(id);
    setStatus("Joined shared room");
  }

  function addObject(object) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.add(object);
    canvas.setActiveObject(object);
    canvas.renderAll();
    saveHistory();
    scheduleSync();
  }

  function addText() {
    addObject(new IText("Double click to edit", {
      left: 250,
      top: 180,
      fontSize: 25,
      fill: color,
      fontFamily: "Arial"
    }));
    setTool("select");
  }

  function addSticky() {
    const note = new Rect({
      left: 280,
      top: 200,
      width: 190,
      height: 145,
      fill: "#fff1a8",
      stroke: "#e5c85c",
      strokeWidth: 1,
      rx: 5,
      ry: 5
    });

    const text = new IText("Write your idea here...", {
      left: 292,
      top: 214,
      width: 165,
      fontSize: 17,
      fill: "#333333"
    });

    addObject(note);
    addObject(text);
    setTool("select");
  }

  function addRectangle() {
    addObject(new Rect({
      left: 250,
      top: 180,
      width: 180,
      height: 110,
      fill: "transparent",
      stroke: color,
      strokeWidth: size
    }));
  }

  function addCircle() {
    addObject(new Circle({
      left: 280,
      top: 180,
      radius: 65,
      fill: "transparent",
      stroke: color,
      strokeWidth: size
    }));
  }

  function addLine() {
    addObject(new Line([250, 200, 450, 300], {
      stroke: color,
      strokeWidth: size
    }));
  }

  async function undo() {
    if (historyIndex.current <= 0) return;

    historyIndex.current--;

    const canvas = canvasRef.current;
    applyingRemote.current = true;

    try {
      await canvas.loadFromJSON(
        JSON.parse(history.current[historyIndex.current])
      );
      canvas.renderAll();
    } finally {
      applyingRemote.current = false;
    }

    scheduleSync();
  }

  async function redo() {
    if (historyIndex.current >= history.current.length - 1) return;

    historyIndex.current++;

    const canvas = canvasRef.current;
    applyingRemote.current = true;

    try {
      await canvas.loadFromJSON(
        JSON.parse(history.current[historyIndex.current])
      );
      canvas.renderAll();
    } finally {
      applyingRemote.current = false;
    }

    scheduleSync();
  }

  function deleteSelected() {
    const canvas = canvasRef.current;
    const selected = canvas?.getActiveObjects();

    if (!selected?.length) return;

    canvas.remove(...selected);
    canvas.discardActiveObject();
    canvas.renderAll();
    saveHistory();
    scheduleSync();
  }

  function saveBoard() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const data = canvas.toJSON();

    localStorage.setItem("my-whiteboard", JSON.stringify(data));

    if (activeRoom.current) {
      syncBoard();
    }

    setStatus("Board saved successfully");
  }

  function exportBoard() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const link = document.createElement("a");
    link.download = "my-whiteboard.png";
    link.href = canvas.toDataURL({
      format: "png",
      multiplier: 1
    });

    link.click();
  }

  function clearBoard() {
    if (!window.confirm("Clear the entire whiteboard?")) return;

    const canvas = canvasRef.current;
    canvas.clear();
    canvas.backgroundColor = "#ffffff";
    canvas.renderAll();
    saveHistory();
    scheduleSync();
  }

  const tools = [
    { name: "select", label: "Select", icon: <MousePointer2 /> },
    { name: "pen", label: "Pen", icon: <Pencil /> },
    { name: "eraser", label: "Eraser", icon: <Eraser /> }
  ];

  return (
    <div className="app">

      <header className="header">
        <div className="brand">
          <div className="brand-icon">✎</div>
          <div>
            <input
              className="board-title"
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
            />
            <p>{status}</p>
          </div>
        </div>

        <div className="header-actions">
          <button onClick={saveBoard}>
            <Save size={16} /> Save
          </button>
          <button onClick={exportBoard}>
            <Download size={16} /> Export
          </button>
        </div>
      </header>

      <div className="collab-bar">
        <div className="room-controls">
          <button onClick={createRoom}>
            <PlusCircle size={16} /> Create Room
          </button>

          <input
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            placeholder="Enter Room ID"
          />

          <button onClick={joinRoom}>
            <Users size={16} /> Join Room
          </button>
        </div>

        <div className="room-info">
          <span>
            Room: <strong>{roomId || "Not joined"}</strong>
          </span>
          <span>{roomStatus}</span>
        </div>
      </div>

      <div className="workspace">

        <aside className="toolbar">
          <p className="toolbar-label">TOOLS</p>

          {tools.map((item) => (
            <button
              key={item.name}
              className={tool === item.name ? "active" : ""}
              title={item.label}
              onClick={() => setTool(item.name)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}

          <div className="separator" />

          <button onClick={addText}>
            <Type /> <span>Text</span>
          </button>
          <button onClick={addSticky}>
            <StickyNote /> <span>Sticky</span>
          </button>
          <button onClick={addRectangle}>
            <Square /> <span>Rectangle</span>
          </button>
          <button onClick={addCircle}>
            <CircleIcon /> <span>Circle</span>
          </button>
          <button onClick={addLine}>
            <Minus /> <span>Line</span>
          </button>

          <div className="separator" />

          <button onClick={undo}>
            <Undo2 /> <span>Undo</span>
          </button>
          <button onClick={redo}>
            <Redo2 /> <span>Redo</span>
          </button>
          <button onClick={deleteSelected}>
            <Trash2 /> <span>Delete</span>
          </button>
        </aside>

        <main className="canvas-area">
          <div className="canvas-heading">
            <span>{boardName}</span>
            <span>Drawing workspace</span>
          </div>

          <div className="canvas-container">
            <canvas ref={canvasElement} />
          </div>
        </main>

        <aside className="properties">
          <h3>Properties</h3>

          <label>Drawing color</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />

          <label>Brush size: {size}px</label>
          <input
            type="range"
            min="1"
            max="25"
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />

          <div className="separator" />

          <h3>Board information</h3>
          <p>Canvas: 1100 × 700</p>
          <p>Storage: Supabase + browser</p>

          <button className="clear-button" onClick={clearBoard}>
            Clear board
          </button>
        </aside>

      </div>

      <footer className="footer">
        <span>Collaborative Whiteboard</span>
        <span>Draw, edit and collaborate with your group</span>
      </footer>

    </div>
  );
}
