// 沙箱里先于 bot 代码执行的脚本：命令对象、console、确定性随机数、禁用 Date 等。
// 用到的内置函数在这里先存一份引用，bot 改全局对象也影响不到这里。
export const PRELUDE = String.raw`
(function () {
  "use strict";
  var G = globalThis;
  var stringify = JSON.stringify, parse = JSON.parse, imul = Math.imul;
  var MAX_LINES = 20, MAX_LINE = 300;
  var logs = [], cmds = [], dropped = 0;

  // 确定性随机数（mulberry32），种子由宿主在 init 时给
  var s = 0;
  Math.random = function () {
    s = (s + 0x6d2b79f5) | 0;
    var t = imul(s ^ (s >>> 15), 1 | s);
    t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  function noDate() { throw new Error("沙箱里不能用 Date，时间请用 view.tick"); }
  noDate.now = noDate;
  G.Date = noDate;
  // 依赖垃圾回收时机的东西会让对局不可复现
  delete G.WeakRef;
  delete G.FinalizationRegistry;

  function fmt(v) {
    if (typeof v === "string") return v;
    try { var j = stringify(v); return j === undefined ? String(v) : j; } catch (e) { return String(v); }
  }
  function log() {
    if (logs.length >= MAX_LINES) { dropped++; return; }
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
    var line = parts.join(" ");
    if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE) + "…";
    logs.push(line);
  }
  G.console = { log: log, warn: log, error: log, info: log, debug: log };

  function idOf(u) { return u !== null && typeof u === "object" ? u.id : u; }
  var cmd = Object.freeze({
    move: function (u, x, y) { cmds.push({ kind: "move", unit: idOf(u), x: x, y: y }); },
    attack: function (u, t) { cmds.push({ kind: "attack", unit: idOf(u), target: idOf(t) }); },
    attackMove: function (u, x, y) { cmds.push({ kind: "attackMove", unit: idOf(u), x: x, y: y }); },
    gather: function (u, t) { cmds.push({ kind: "gather", unit: idOf(u), target: idOf(t) }); },
    stop: function (u) { cmds.push({ kind: "stop", unit: idOf(u) }); },
    produce: function (b, type) { cmds.push({ kind: "produce", building: idOf(b), type: type }); },
    cancel: function (b) { cmds.push({ kind: "cancel", building: idOf(b) }); }
  });

  G.dist = function (a, b) {
    var aw = a.w || 1, ah = a.h || 1, bw = b.w || 1, bh = b.h || 1;
    var dx = Math.max(0, b.x - (a.x + aw - 1), a.x - (b.x + bw - 1));
    var dy = Math.max(0, b.y - (a.y + ah - 1), a.y - (b.y + bh - 1));
    return dx + dy;
  };

  function flush(err) {
    var out = { c: cmds, l: logs, d: dropped };
    if (err !== undefined) { out.e = err; out.c = []; }
    cmds = []; logs = []; dropped = 0;
    return stringify(out);
  }
  function errText(e) {
    if (e !== null && typeof e === "object") {
      var head = (e.name || "Error") + ": " + e.message;
      return e.stack ? head + "\n" + e.stack : head;
    }
    return "抛出了非 Error 的值：" + fmt(e);
  }

  // bot 模块导出的函数，加载后由宿主传进来
  var botTick, botStart;

  G.__arena = {
    init: function (gameJson, seed) { G.game = parse(gameJson); s = seed | 0; },
    start: function (tickFn, startFn) {
      botTick = tickFn;
      botStart = startFn;
      if (typeof botTick !== "function")
        return flush("没有导出 onTick（应写成 export function onTick(view: View, cmd: Commands) { ... }）");
      if (typeof botStart === "function") {
        try { botStart(G.game); } catch (e) { return flush(errText(e)); }
      }
      return flush();
    },
    tick: function (viewJson) {
      var view = parse(viewJson);
      cmds = [];
      try { botTick(view, cmd); } catch (e) { return flush(errText(e)); }
      return flush();
    },
    drain: function () { return flush(""); }
  };
})();
`
