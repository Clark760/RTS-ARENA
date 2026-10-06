// 沙箱规则包的 prelude：在规则包代码之前执行，搭出规则包用的 ctx（SetupContext + RuleContext）。
// - 读（实体、玩家、事件）：向宿主要一份 JSON 快照，同一 tick 里的几次回调（onTick、result、objectives）共用；
//   规则包自己改了局面（刷实体、移除）就作废重取。
// - 写（加分、刷实体、出局……）：转给宿主执行，宿主检查参数；玩家的分数、资源、出局在缓存里同步改，和直接拿内核对象时看到的一样。
// - 随机数：ctx.rng 每次都向宿主取，和规则包不进沙箱时是同一串数（同样的种子结果完全一样）。
// 宿主函数在 __host 上，这里取走后从全局删掉；宿主那边仍然检查每个调用，删掉只是让规则包少一个误用的入口。
export function rulesPreludeSource(maxLines: number, maxLine: number): string {
  return String.raw`
(function () {
  "use strict";
  var G = globalThis, H = G.__host;
  delete G.__host;
  var stringify = JSON.stringify, parse = JSON.parse, imul = Math.imul;
  var MAX_LINES = ${maxLines}, MAX_LINE = ${maxLine};
  var logs = [], dropped = 0;

  var s = 0;
  Math.random = function () {
    s = (s + 0x6d2b79f5) | 0;
    var t = imul(s ^ (s >>> 15), 1 | s);
    t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  function noDate() { throw new Error("沙箱里不能用 Date，时间请用 ctx.tick"); }
  noDate.now = noDate;
  G.Date = noDate;
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

  function rectDist(a, b) {
    var aw = a.w || 1, ah = a.h || 1, bw = b.w || 1, bh = b.h || 1;
    var dx = Math.max(0, b.x - (a.x + aw - 1), a.x - (b.x + bw - 1));
    var dy = Math.max(0, b.y - (a.y + ah - 1), a.y - (b.y + bh - 1));
    return dx + dy;
  }

  var defs = {}, teams = [], cache = {}, stampNow = null;
  /** 宿主省掉了和默认值一样的字段，这里补全 */
  function fill(list) {
    for (var i = 0; i < list.length; i++) {
      var e = list[i], d = defs[e.type];
      e.def = d;
      if (e.w === undefined) { e.w = d.w; e.h = d.h; }
      if (e.amount === undefined) e.amount = 0;
      if (e.order === undefined) e.order = { kind: "idle" };
      if (e.carrying === undefined) e.carrying = null;
      if (e.queue === undefined) e.queue = [];
      if (e.construction === undefined) e.construction = null;
      e.alive = true;
    }
    return list;
  }
  function ents() {
    if (!cache.ents) {
      cache.ents = fill(parse(H.entities()));
      cache.byId = null;
    }
    return cache.ents;
  }
  function matches(e, f) {
    return (f.owner === undefined || e.owner === f.owner) && (f.type === undefined || e.type === f.type) && (f.kind === undefined || e.def.kind === f.kind);
  }
  function byId() {
    if (!cache.byId) {
      var m = new Map(), list = ents();
      for (var i = 0; i < list.length; i++) m.set(list[i].id, list[i]);
      cache.byId = m;
    }
    return cache.byId;
  }
  function players() {
    if (!cache.players) cache.players = parse(H.players());
    return cache.players;
  }
  /** 局面里的实体变了：实体和事件都要重取 */
  function entsChanged() { cache.ents = null; cache.byId = null; cache.events = null; }
  function amountOf(o) { return o !== null && typeof o === "object" && typeof o.amount === "number" ? o.amount : undefined; }

  var rng = Object.freeze({
    next: function () { return H.rng(); },
    int: function (n) { return H.rng() % n; },
    shuffle: function (arr) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = H.rng() % (i + 1);
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
    }
  });

  var ctx = Object.freeze({
    get seed() { return H.seed(); },
    get playerCount() { return H.playerCount(); },
    get teams() { return teams.slice(); },
    get tick() { return H.tick(); },
    get maxTicks() { return H.maxTicks(); },
    get width() { return H.width(); },
    get height() { return H.height(); },
    get rng() { return rng; },
    isAlly: function (a, b) { return a >= 0 && b >= 0 && teams[a] === teams[b]; },
    setTerrain: function (rows) { H.setTerrain(stringify(rows)); entsChanged(); },
    spawn: function (type, owner, x, y, o) { var id = H.spawn(type, owner, x, y, amountOf(o)); entsChanged(); return id; },
    setResources: function (p, res) {
      H.setResources(p, stringify(res));
      if (cache.players) for (var k in res) cache.players[p].resources[k] = res[k];
    },
    setMarkers: function (m) { H.setMarkers(stringify(m)); },
    setStatus: function (t) { H.setStatus(String(t)); },
    entities: function (f) {
      if (f === undefined || f === null) return ents().slice();
      // 已经有全量快照就在这里筛，否则让宿主筛好再传进来
      if (cache.ents) return cache.ents.filter(function (e) { return matches(e, f); });
      return fill(parse(H.entitiesWhere(stringify({ owner: f.owner, type: f.type, kind: f.kind }))));
    },
    get: function (id) { return byId().get(id); },
    get players() { return players(); },
    get events() {
      if (!cache.events) cache.events = parse(H.events());
      return cache.events;
    },
    dist: rectDist,
    entitiesIn: function (x, y, w, h) {
      if (!cache.ents) return fill(parse(H.entitiesIn(x, y, w, h)));
      var r = { x: x, y: y, w: w, h: h }, out = [], list = cache.ents;
      for (var i = 0; i < list.length; i++) if (rectDist(list[i], r) === 0) out.push(list[i]);
      return out;
    },
    addScore: function (p, n) { H.addScore(p, n); if (cache.players) cache.players[p].score += n; },
    setScore: function (p, n) { H.setScore(p, n); if (cache.players) cache.players[p].score = n; },
    addResource: function (p, r, n) { H.addResource(p, r, n); if (cache.players) cache.players[p].resources[r] += n; },
    spawnNear: function (type, owner, x, y, o) {
      var id = H.spawnNear(type, owner, x, y, amountOf(o));
      entsChanged();
      return id < 0 ? null : id;
    },
    remove: function (id) {
      var e = cache.ents ? byId().get(id) : undefined;
      H.remove(id);
      if (e) e.alive = false;
      entsChanged();
    },
    eliminate: function (p) { H.eliminate(p); if (cache.players) cache.players[p].alive = false; },
    orderNeutral: function (id, order) { H.orderNeutral(id, stringify(order)); entsChanged(); },
    setHp: function (id, hp) { H.setHp(id, hp); entsChanged(); },
    setOwner: function (id, owner) { H.setOwner(id, owner); entsChanged(); }
  });

  function errText(e) {
    if (e !== null && typeof e === "object") {
      var head = (e.name || "Error") + ": " + e.message;
      return e.stack ? head + "\n" + e.stack : head;
    }
    return "抛出了非 Error 的值：" + fmt(e);
  }

  var R = null;
  var KEYS = ["id", "name", "players", "teams", "maxTicks", "tickRate", "decisionInterval", "fuel", "unitCap", "fog", "resources", "terrain", "types"];
  var FNS = ["setup", "onTick", "objectives", "result", "timeUp", "buildCheck"];

  G.__rules = {
    bind: function (ns) { R = ns !== null && typeof ns === "object" ? ns["default"] : null; },
    describe: function () {
      if (R === null || typeof R !== "object") return stringify({ e: "index.ts 要用 export default 导出规则包对象" });
      try {
        var data = {}, fns = [];
        for (var i = 0; i < KEYS.length; i++) data[KEYS[i]] = R[KEYS[i]];
        for (var j = 0; j < FNS.length; j++) if (typeof R[FNS[j]] === "function") fns.push(FNS[j]);
        return stringify({ d: data, f: fns });
      } catch (e) { return stringify({ e: errText(e) }); }
    },
    begin: function (typesJson, teamsJson, seed) { defs = parse(typesJson); teams = parse(teamsJson); s = seed | 0; },
    call: function (name, argsJson, stamp) {
      logs = []; dropped = 0;
      // 宿主保证同一个 stamp 期间局面只会被规则包自己改；setup 时 stamp 是 -1，每次都重取
      if (stamp !== stampNow || stamp < 0) { cache = {}; stampNow = stamp; }
      var out;
      try {
        var args = parse(argsJson);
        args.unshift(ctx);
        var v = R[name].apply(R, args);
        out = { v: v === undefined ? null : v };
      } catch (e) {
        out = { e: errText(e) };
      }
      out.l = logs;
      out.d = dropped;
      try { return stringify(out); } catch (e2) { return stringify({ e: "返回值不能转成 JSON：" + errText(e2), l: logs, d: dropped }); }
    }
  };
})();
`
}
