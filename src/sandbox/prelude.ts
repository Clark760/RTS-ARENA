// 沙箱里先于 bot 代码执行的脚本：命令对象、console、确定性随机数、禁用 Date 等。
// JSON 的方法在这里先存一份引用；但 bot 改 Array、String、Object 的原型仍能影响这里的行为，
// 所以这里的上限只是尽量做到，真正的上限由宿主（quickjs.ts 的 readOut）强制。
export function preludeSource(maxCommands: number, maxLines: number, maxLine: number): string {
  return String.raw`
(function () {
  "use strict";
  var G = globalThis;
  var stringify = JSON.stringify, parse = JSON.parse, imul = Math.imul;
  var MAX_LINES = ${maxLines}, MAX_LINE = ${maxLine}, MAX_CMDS = ${maxCommands};
  var logs = [], cmds = [], dropped = 0, overflow = 0;

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

  // 命令参数在这里就转成数字或字符串（非法的变 null，由宿主拒绝），flush 时序列化就不会再执行 bot 的代码
  function num(v) { return typeof v === "number" ? v : null; }
  function idOf(u) {
    if (typeof u === "number") return u;
    if (u !== null && typeof u === "object") { var id = u.id; return typeof id === "number" ? id : null; }
    return null;
  }
  function push(c) { if (cmds.length < MAX_CMDS) cmds.push(c); else overflow++; }
  var cmd = Object.freeze({
    move: function (u, x, y) { push({ kind: "move", unit: idOf(u), x: num(x), y: num(y) }); },
    attack: function (u, t) { push({ kind: "attack", unit: idOf(u), target: idOf(t) }); },
    attackMove: function (u, x, y) { push({ kind: "attackMove", unit: idOf(u), x: num(x), y: num(y) }); },
    gather: function (u, t) { push({ kind: "gather", unit: idOf(u), target: idOf(t) }); },
    stop: function (u) { push({ kind: "stop", unit: idOf(u) }); },
    produce: function (b, type) { push({ kind: "produce", building: idOf(b), type: typeof type === "string" ? type : null }); },
    cancel: function (b) { push({ kind: "cancel", building: idOf(b) }); },
    build: function (u, type, x, y) {
      push({ kind: "build", unit: idOf(u), type: typeof type === "string" ? type : null, x: num(x), y: num(y) });
    }
  });

  function dist(a, b) {
    var aw = a.w || 1, ah = a.h || 1, bw = b.w || 1, bh = b.h || 1;
    var dx = Math.max(0, b.x - (a.x + aw - 1), a.x - (b.x + bw - 1));
    var dy = Math.max(0, b.y - (a.y + ah - 1), a.y - (b.y + bh - 1));
    return dx + dy;
  }
  G.dist = dist;

  // 和引擎放地基的检查一致：在地图内、地形可走、没有实体、每格都在己方（含盟友）某个实体的视野里
  G.canBuild = function (view, type, x, y) {
    var g = G.game, d = g.types[type];
    if (!d || d.kind !== "building" || x !== (x | 0) || y !== (y | 0)) return false;
    if (x < 0 || y < 0 || x + d.w > g.width || y + d.h > g.height) return false;
    var yy, xx, i, es = view.entities, team = view.players[view.me].team, r = { x: x, y: y, w: d.w, h: d.h };
    for (yy = y; yy < y + d.h; yy++) for (xx = x; xx < x + d.w; xx++) if (!g.walkable[g.terrain[yy][xx]]) return false;
    for (i = 0; i < es.length; i++) if (dist(es[i], r) === 0) return false;
    if (!g.fog) return true;
    for (yy = y; yy < y + d.h; yy++)
      for (xx = x; xx < x + d.w; xx++) {
        var seen = false, cell = { x: xx, y: yy };
        for (i = 0; i < es.length && !seen; i++) {
          var e = es[i];
          if (e.owner >= 0 && view.players[e.owner].team === team && dist(e, cell) <= g.types[e.type].sight) seen = true;
        }
        if (!seen) return false;
      }
    return true;
  };

  function flush(err) {
    var out = { c: cmds, l: logs, d: dropped, o: overflow };
    if (err !== undefined) { out.e = err; out.c = []; }
    cmds = []; logs = []; dropped = 0; overflow = 0;
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
}
