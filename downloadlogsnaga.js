// ==UserScript==
// @name         downloadlogsnaga
// @namespace    https://github.com/honvl/Majsoul-to-NAGA
// @version      1.0.2-naga
// @description  Press "s" in a MahjongSoul 4-player replay to copy the NAGA-compatible log to your clipboard and request a NAGA analysis, entirely in-browser.
// @author       honvl, AsaChiri
// @homepageURL  https://github.com/honvl/Majsoul-to-NAGA
// @supportURL   https://github.com/honvl/Majsoul-to-NAGA/issues
// @downloadURL  https://raw.githubusercontent.com/honvl/Majsoul-to-NAGA/master/downloadlogsnaga.js
// @updateURL    https://raw.githubusercontent.com/honvl/Majsoul-to-NAGA/master/downloadlogsnaga.js
// @license      MIT
// @match        https://game.maj-soul.com/1/*
// @match        https://mahjongsoul.game.yo-star.com/*
// @match        https://game.mahjongsoul.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_setClipboard
// @connect      naga.dmv.nico
// @connect      maj-soul.com
// @connect      mahjongsoul.com
// @connect      yo-star.com
// ==/UserScript==

/*
 * Adapted from AsaChiri/majsoul-naga, commit
 * 1eb3c4519716ffa3cfdd0b8b0529aace77913458.
 *
 * Why a userscript: MahjongSoul now blocks programmatic API login (error 151)
 * and no longer exposes the GameMgr/app globals older scripts relied on. So this
 * hooks window.WebSocket, captures the raw `fetchGameRecord` response frame when
 * you open a replay, decodes the MahjongSoul protobuf itself (a tiny generic
 * wire-decoder keyed by field numbers), converts to tenhou.net/6, and submits to
 * NAGA using your existing NAGA browser session.
 *
 * The converter is validated by a Node golden test (test/run.cjs) against a
 * fixture produced by a pipeline checked round-for-round against tensoul-py.
 */
(function () {
  "use strict";

  // ---- config ------------------------------------------------------------
  const PLAYER_TYPES = "2"; // NAGA models: 0=オメガ 1=ガンマ 2=ニシキ 3=ヒバカリ 4=カガシ (comma-join for multi)
  const TRIGGER_KEY = "s";
  const NAGA = "https://naga.dmv.nico";

  // ---- logging (single, consistent prefix) ------------------------------
  const TAG = "[majsoul-naga]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const logError = (...a) => console.error(TAG, ...a);

  // ---- generic protobuf wire decoder ------------------------------------
  // decode(Uint8Array) -> { fieldNumber: [values] }, value = number (varint) or Uint8Array (len-delimited)
  // varints are read as BigInt for exactness; negative int32/64 are sign-extended
  // to a full 64-bit varint, so values are interpreted as signed.
  const TWO63 = 1n << 63n,
    TWO64 = 1n << 64n;
  const toSigned = (b) => (b >= TWO63 ? b - TWO64 : b);
  const num = (b) => Number(toSigned(b));
  function readVarint(buf, p) {
    let shift = 0n,
      result = 0n;
    for (;;) {
      const b = buf[p.i++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  }
  function decode(buf) {
    const out = {},
      p = { i: 0 };
    while (p.i < buf.length) {
      const tag = Number(readVarint(buf, p)),
        fn = tag >> 3,
        wt = tag & 7;
      let val;
      if (wt === 0) val = readVarint(buf, p);
      else if (wt === 2) {
        const len = Number(readVarint(buf, p));
        val = buf.subarray(p.i, p.i + len);
        p.i += len;
      } else if (wt === 1) {
        p.i += 8;
        val = 0n;
      } else if (wt === 5) {
        p.i += 4;
        val = 0n;
      } else break;
      (out[fn] = out[fn] || []).push(val);
    }
    return out;
  }
  const TD = new TextDecoder();
  const one = (m, n) => (m[n] ? m[n][0] : undefined);
  const all = (m, n) => m[n] || [];
  const pint = (m, n) => {
    const v = one(m, n);
    return v === undefined ? 0 : num(v);
  };
  const pbool = (m, n) => {
    const v = one(m, n);
    return v !== undefined && v !== 0n;
  };
  const pstr = (m, n) => {
    const v = one(m, n);
    return v instanceof Uint8Array ? TD.decode(v) : "";
  };
  const pstrs = (m, n) =>
    all(m, n)
      .filter((v) => v instanceof Uint8Array)
      .map((v) => TD.decode(v));
  const psub = (m, n) => {
    const v = one(m, n);
    return v instanceof Uint8Array ? decode(v) : null;
  };
  const psubs = (m, n) =>
    all(m, n)
      .filter((v) => v instanceof Uint8Array)
      .map((v) => decode(v));
  function pints(m, n) {
    // packed-or-unpacked repeated varints (signed)
    const out = [];
    for (const v of all(m, n)) {
      if (v instanceof Uint8Array) {
        const p = { i: 0 };
        while (p.i < v.length) out.push(num(readVarint(v, p)));
      } else out.push(num(v));
    }
    return out;
  }

  // ---- tiles -------------------------------------------------------------
  const TSUMOGIRI = 60;
  const TYPE = { m: 0, p: 1, s: 2, z: 3 };
  function tile(text) {
    return { num: parseInt(text[0], 10), t: TYPE[text[1].toLowerCase()] };
  }
  function tEnc(x) {
    return x.num !== 0 ? 10 * (x.t + 1) + x.num : 50 + (x.t + 1);
  }
  function tDeaka(x) {
    return x.num === 0 && x.t !== TYPE.z ? { num: 5, t: x.t } : x;
  }
  const tEq = (a, b) => a.num === b.num && a.t === b.t;

  // ---- meld / discard encoders (return int or string) -------------------
  function encDiscard(s) {
    let v = s.tsumogiri ? TSUMOGIRI : tEnc(s.tile);
    return s.riichi ? "r" + v : v;
  }
  function encChi(s) {
    return "c" + tEnc(s.called) + tEnc(s.a) + tEnc(s.b);
  }
  function encPon(s) {
    const t = [String(tEnc(s.a)), String(tEnc(s.b))];
    t.splice(s.fr, 0, "p" + tEnc(s.called));
    return t.join("");
  }
  function encDaiminkan(s) {
    let pos = s.fr === 2 ? 3 : s.fr;
    const t = [String(tEnc(s.a)), String(tEnc(s.b)), String(tEnc(s.c))];
    t.splice(pos, 0, "m" + tEnc(s.called));
    return t.join("");
  }
  function encAnkan(s) {
    const t = tEnc(s.tile);
    if (s.tile.num === 5 && s.tile.t !== TYPE.z) {
      return "" + tEnc({ num: 0, t: s.tile.t }) + t + t + "a" + t;
    }
    return "" + t + t + t + "a" + t;
  }
  function encKakan(s) {
    const t = [String(tEnc(s.a)), String(tEnc(s.b)), String(tEnc(s.c))];
    t.splice(s.fr, 0, "k" + tEnc(s.added));
    return t.join("");
  }
  const encZero = () => 0;
  function encStream(item) {
    if (item.kind === "tile") return tEnc(item);
    return item.enc(item);
  }

  // ---- scoring constants & yaku -----------------------------------------
  const DAISANGEN = 37,
    DAISUUSHI = 50;
  const TSUMO_OYA_PAYS_KO = 16000,
    TSUMO_KO_PAYS_OYA = 16000,
    TSUMO_KO_PAYS_KO = 8000,
    RON_OYA = 48000,
    RON_KO = 32000;
  const WINDS = ["東", "南", "西", "北"];
  const LIMIT = {
    mangan: "満貫",
    haneman: "跳満",
    baiman: "倍満",
    sanbaiman: "三倍満",
    yakuman: "役満",
    kazoe: "数え役満",
    kiriage: "切り上げ満貫",
  };
  const ABORT = { 1: "九種九牌", 2: "四風連打", 3: "四家立直", 4: "四開槓", 5: "三家和" };
  const YAKU_NAMES = {
    1: "門前清自摸和",
    2: "立直",
    3: "槍槓",
    4: "嶺上開花",
    5: "海底摸月",
    6: "河底撈魚",
    7: "役牌 白",
    8: "役牌 發",
    9: "役牌 中",
    10: "役牌:自風牌",
    11: "役牌:場風牌",
    12: "断幺九",
    13: "一盃口",
    14: "平和",
    15: "混全帯幺九",
    16: "一気通貫",
    17: "三色同順",
    18: "ダブル立直",
    19: "三色同刻",
    20: "三槓子",
    21: "対々和",
    22: "三暗刻",
    23: "小三元",
    24: "混老頭",
    25: "七対子",
    26: "純全帯幺九",
    27: "混一色",
    28: "二盃口",
    29: "清一色",
    30: "一発",
    31: "ドラ",
    32: "赤ドラ",
    33: "裏ドラ",
    34: "抜きドラ",
    35: "天和",
    36: "地和",
    37: "大三元",
    38: "四暗刻",
    39: "字一色",
    40: "緑一色",
    41: "清老頭",
    42: "国士無双",
    43: "小四喜",
    44: "四槓子",
    45: "九蓮宝燈",
    46: "八連荘",
    47: "純正九蓮宝燈",
    48: "四暗刻単騎",
    49: "国士無双十三面待ち",
    50: "大四喜",
    51: "燕返し",
    52: "槓振り",
    53: "十二落抬",
    54: "五門斉",
    55: "三連刻",
    56: "一色三順",
    57: "一筒摸月",
    58: "九筒撈魚",
    59: "人和",
    60: "大車輪",
    61: "大竹林",
    62: "大数隣",
    63: "石の上にも三年",
    64: "大七星",
    1000: "根",
    1001: "嶺上開花",
    1002: "嶺上放銃",
    1003: "無番和",
    1004: "槍槓",
    1005: "対々和",
    1006: "清一色",
    1007: "七対子",
    1008: "帯幺九",
    1009: "金勾釣",
    1010: "清対",
    1011: "将対",
    1012: "龍七対",
    1013: "清七対",
    1014: "清金勾釣",
    1015: "清龍七対",
    1016: "十八羅漢",
    1017: "清十八羅漢",
    1018: "天和",
    1019: "地和",
    1020: "清幺九",
    1021: "海底摸月",
  };

  function yakuName(id, rnd, seat) {
    if (id === 10) return "自風 " + WINDS[(((seat - rnd.kyoku) % 4) + 4) % 4];
    if (id === 11) return "場風 " + WINDS[Math.floor(rnd.kyoku / 4)];
    if (id === 18) return "両立直";
    return YAKU_NAMES[id] || "yaku" + id;
  }
  function pointLevel(pt) {
    let j;
    if (pt.ron === 0) j = pt.oya ? (pt.tsumo * 3) / 1.5 : pt.tsumo * 2 + pt.tsumo_oya;
    else j = pt.oya ? pt.ron / 1.5 : pt.ron;
    if (j >= 32000) return "yakuman";
    if (j >= 24000) return "sanbaiman";
    if (j >= 16000) return "baiman";
    if (j >= 12000) return "haneman";
    if (j >= 8000) return "mangan";
    return null;
  }
  function scoreString(w) {
    let pts;
    if (w.tsumo) pts = w.oya ? `${w.point.tsumo}点∀` : `${w.point.tsumo}-${w.point.tsumo_oya}点`;
    else pts = `${w.point.ron}点`;
    const lv = pointLevel(w.point);
    if (lv === null) return `${w.fu}符${w.han}飜${pts}`;
    let prefix;
    if (lv === "yakuman") prefix = w.han >= 13 ? LIMIT.kazoe : LIMIT.yakuman;
    else if (lv === "mangan") {
      const tm = w.han >= 5 || (w.han >= 4 && w.fu >= 40) || (w.han >= 3 && w.fu >= 70);
      prefix = tm ? LIMIT.mangan : LIMIT.kiriage;
    } else prefix = LIMIT[lv];
    return prefix + pts;
  }

  // ---- game parser (port of records.py) ---------------------------------
  const rel = (seat, feeder) => (seat - feeder + 3) % 4;
  function GameParser() {
    this.kyokus = [];
    this.cur = null;
  }
  GameParser.prototype.feed = function (name, m) {
    switch (name) {
      case "RecordNewRound":
        return this._newRound(m);
      case "RecordDealTile":
        return this._deal(m);
      case "RecordDiscardTile":
        return this._discard(m);
      case "RecordChiPengGang":
        return this._call(m);
      case "RecordAnGangAddGang":
        return this._kan(m);
      case "RecordLiuJu":
        return this._liuju(m);
      case "RecordNoTile":
        return this._notile(m);
      case "RecordHule":
        return this._hule(m);
    }
  };
  GameParser.prototype._acceptRiichi = function () {
    if (this._pending) {
      this._pending = false;
      this.nriichi++;
    }
  };
  GameParser.prototype._dora = function (doras) {
    if (doras.length > this.cur.doras.length) this.cur.doras = doras.map(tile);
  };
  GameParser.prototype._countPao = function (t, owner, feeder) {
    if (t.t !== TYPE.z) return;
    if (t.num >= 1 && t.num <= 4) {
      if (++this.nowinds[owner] === 4) this.paowind = feeder;
    } else if (t.num >= 5 && t.num <= 7) {
      if (++this.nodrags[owner] === 3) this.paodrag = feeder;
    }
  };
  GameParser.prototype._newRound = function (m) {
    const scores = pints(m, 5);
    if (scores.length !== 4) throw new Error("only 4-player games are supported (got " + scores.length + ")");
    const dora = pstr(m, 4);
    const doras = dora ? [tile(dora)] : pstrs(m, 16).map(tile);
    const haipais = [7, 8, 9, 10].map((n) => pstrs(m, n).map(tile));
    this.cur = {
      rnd: { kyoku: 4 * pint(m, 1) + pint(m, 2), honba: pint(m, 3), riichi: pint(m, 6) },
      init: scores,
      doras,
      draws: [[], [], [], []],
      discards: [[], [], [], []],
      haipais,
      result: null,
    };
    this.dealer = pint(m, 2);
    this.popped = this.cur.haipais[this.dealer].pop();
    this.cur.draws[this.dealer].push({ kind: "tile", ...this.popped });
    this.ldseat = -1;
    this.nriichi = 0;
    this.nkan = 0;
    this._pending = false;
    this.nowinds = [0, 0, 0, 0];
    this.nodrags = [0, 0, 0, 0];
    this.paowind = -1;
    this.paodrag = -1;
  };
  GameParser.prototype._deal = function (m) {
    this._acceptRiichi();
    this._dora(pstrs(m, 6));
    this.cur.draws[pint(m, 1)].push({ kind: "tile", ...tile(pstr(m, 2)) });
  };
  GameParser.prototype._discard = function (m) {
    const seat = pint(m, 1),
      t = tile(pstr(m, 2));
    let tg = pbool(m, 5);
    if (seat === this.dealer && this.cur.discards[seat].length === 0 && this.popped && tEq(t, this.popped))
      tg = true;
    const riichi = pbool(m, 3);
    this.cur.discards[seat].push({ enc: encDiscard, tile: t, tsumogiri: tg, riichi });
    if (riichi) this._pending = true;
    this.ldseat = seat;
    this._dora(pstrs(m, 8));
  };
  GameParser.prototype._call = function (m) {
    this._acceptRiichi();
    const seat = pint(m, 1),
      type = pint(m, 2),
      tiles = pstrs(m, 3).map(tile);
    if (type === 0) this.cur.draws[seat].push({ enc: encChi, a: tiles[0], b: tiles[1], called: tiles[2] });
    else if (type === 1) {
      const fr = rel(seat, this.ldseat);
      this._countPao(tiles[0], seat, this.ldseat);
      this.cur.draws[seat].push({ enc: encPon, a: tiles[0], b: tiles[1], called: tiles[2], fr });
    } else if (type === 2) {
      const fr = rel(seat, this.ldseat);
      this._countPao(tiles[0], seat, this.ldseat);
      this.cur.draws[seat].push({
        enc: encDaiminkan,
        a: tiles[0],
        b: tiles[1],
        c: tiles[2],
        called: tiles[3],
        fr,
      });
      this.cur.discards[seat].push({ enc: encZero });
      this.nkan++;
    } else throw new Error("bad RecordChiPengGang.type=" + type);
  };
  GameParser.prototype._kan = function (m) {
    const seat = pint(m, 1),
      type = pint(m, 2),
      t = tile(pstr(m, 3));
    this.ldseat = seat;
    if (type === 3) {
      this._countPao(t, seat, -1);
      this.cur.discards[seat].push({ enc: encAnkan, tile: tDeaka(t) });
      this.nkan++;
    } else if (type === 2) {
      for (const s of this.cur.draws[seat]) {
        if (s.enc === encPon && tEq(tDeaka(s.called), tDeaka(t))) {
          this.cur.discards[seat].push({ enc: encKakan, a: s.a, b: s.b, c: s.called, added: t, fr: s.fr });
          this.nkan++;
          break;
        }
      }
    } else throw new Error("bad RecordAnGangAddGang.type=" + type);
  };
  GameParser.prototype._finish = function () {
    this.kyokus.push(this.cur);
    this.cur = null;
  };
  GameParser.prototype._liuju = function (m) {
    this._acceptRiichi();
    const type = pint(m, 1);
    let r;
    if (type === 1) r = 1;
    else if (type === 2) r = 2;
    else if (this.nriichi === 4) r = 3;
    else if (this.nkan === 4) r = 4;
    else throw new Error("bad RecordLiuJu.type=" + type);
    this.cur.result = { kind: "abort", code: r };
    this._finish();
  };
  GameParser.prototype._notile = function (m) {
    const delta = [0, 0, 0, 0];
    for (const s of psubs(m, 3)) {
      const d = pints(s, 3);
      d.forEach((x, i) => (delta[i] += x));
    }
    this.cur.result = { kind: "ryuukyoku", delta, nagashi: pbool(m, 1) };
    this._finish();
  };
  GameParser.prototype._hule = function (m) {
    const wins = [];
    let ura = [];
    for (const h of psubs(m, 1)) {
      const li = pstrs(h, 9);
      if (li.length > ura.length) ura = li.map(tile);
      wins.push(this._parseHule(h));
    }
    this.cur.result = { kind: "agari", wins, ura, rnd: this.cur.rnd };
    this._finish();
  };
  GameParser.prototype._parseHule = function (h) {
    let rp, hb;
    if (this.nriichi !== -1) {
      rp = 1000 * (this.nriichi + this.cur.rnd.riichi);
      hb = 100 * this.cur.rnd.honba;
    } else {
      rp = 0;
      hb = 0;
    }
    const seat = pint(h, 4),
      zimo = pbool(h, 5),
      qinjia = pbool(h, 6),
      yiman = pbool(h, 10);
    const count = pint(h, 11),
      fu = pint(h, 13);
    const rong = pint(h, 15),
      zqin = pint(h, 16),
      zxian = pint(h, 17);
    const fans = psubs(h, 12).map((f) => ({ id: pint(f, 3), val: pint(f, 2) }));

    // pao
    let pao = false,
      liable = -1,
      liableFor = 0;
    if (yiman)
      for (const f of fans) {
        if (f.id === DAISUUSHI && this.paowind !== -1) {
          pao = true;
          liable = this.paowind;
          liableFor = f.val;
          break;
        }
        if (f.id === DAISANGEN && this.paodrag !== -1) {
          pao = true;
          liable = this.paodrag;
          liableFor = f.val;
          break;
        }
      }

    let delta, point;
    if (zimo) {
      delta = [-hb - zxian, -hb - zxian, -hb - zxian, -hb - zxian];
      if (seat === this.dealer) {
        delta[seat] = rp + 3 * (hb + zxian);
        point = { tsumo: zxian, tsumo_oya: 0, ron: 0, oya: true };
      } else {
        delta[seat] = rp + hb + zqin + 2 * (hb + zxian);
        delta[this.dealer] = -hb - zqin;
        point = { tsumo: zxian, tsumo_oya: zqin, ron: 0, oya: false };
      }
    } else {
      delta = [0, 0, 0, 0];
      delta[seat] = rp + 3 * hb + rong;
      delta[this.ldseat] = -3 * hb - rong;
      point = { ron: rong, tsumo: 0, tsumo_oya: 0, oya: qinjia };
      this.nriichi = -1;
    }
    if (pao) {
      if (!zimo) {
        const pay = 3 * hb + Math.floor((liableFor * (qinjia ? RON_OYA : RON_KO)) / 2);
        delta[liable] -= pay;
        delta[this.ldseat] += pay;
      } else if (qinjia) {
        delta[liable] -= 2 * hb + liableFor * 2 * TSUMO_OYA_PAYS_KO;
        for (let i = 0; i < 4; i++)
          if (i !== liable && i !== seat) delta[i] += hb + liableFor * TSUMO_OYA_PAYS_KO;
      } else {
        delta[liable] -= 2 * hb + liableFor * (TSUMO_KO_PAYS_OYA + TSUMO_KO_PAYS_KO);
        for (let i = 0; i < 4; i++)
          if (i !== liable && i !== seat)
            delta[i] += hb + liableFor * (i === this.dealer ? TSUMO_KO_PAYS_OYA : TSUMO_KO_PAYS_KO);
      }
    }
    return {
      seat,
      from: zimo ? seat : this.ldseat,
      pao: pao ? liable : seat,
      han: count,
      fu,
      yaku: fans,
      oya: qinjia,
      tsumo: zimo,
      yakuman: yiman,
      point,
      delta,
    };
  };

  // ---- result + round encoders (port of model.py/scoring.py) ------------
  function dumpResult(r) {
    if (r.kind === "abort") return [ABORT[r.code]];
    if (r.kind === "ryuukyoku") return [r.nagashi ? "流し満貫" : "流局", r.delta];
    const out = ["和了"];
    for (const w of r.wins) {
      out.push(w.delta);
      const detail = [w.seat, w.from, w.pao, scoreString(w)];
      for (const y of w.yaku)
        detail.push(`${yakuName(y.id, r.rnd, w.seat)}(${w.yakuman ? "役満" : y.val + "飜"})`);
      out.push(detail);
    }
    return out;
  }
  function dumpKyoku(k) {
    const entry = [
      [k.rnd.kyoku, k.rnd.honba, k.rnd.riichi],
      k.init,
      k.doras.map(tEnc),
      k.result && k.result.kind === "agari" ? k.result.ura.map(tEnc) : [],
    ];
    for (let seat = 0; seat < 4; seat++) {
      entry.push(k.haipais[seat].map(tEnc));
      entry.push(k.draws[seat].map(encStream));
      entry.push(k.discards[seat].map(encStream));
    }
    if (k.result) entry.push(dumpResult(k.result));
    return entry;
  }

  // ---- ResGameRecord -> tenhou.net/6 ------------------------------------
  // Split decode (header + data/data_url) from convert, so large replays that
  // return a `data_url` instead of inline `data` can be fetched asynchronously.
  function decodeRecord(resBytes) {
    const res = decode(resBytes);
    const err = psub(res, 1);
    if (err && pint(err, 1)) throw new Error("fetch_game_record error " + pint(err, 1));
    const head = psub(res, 3) || {};
    const cfg = psub(head, 5); // RecordGame.config -> GameConfig
    const gmode = cfg ? psub(cfg, 2) : null; // GameConfig.mode -> GameMode
    const mode = gmode ? pint(gmode, 1) : 0; // GameMode.mode: 1=East(tonpuu), 2=South(hanchan)

    // names from RecordGame.accounts (AccountInfo: seat=2, nickname=3)
    const names = ["AI", "AI", "AI", "AI"];
    for (const a of psubs(head, 11)) {
      const seat = pint(a, 2),
        nick = pstr(a, 3);
      if (seat >= 0 && seat < 4 && nick) names[seat] = nick;
    }
    // final scores from RecordGame.result.players (PlayerItem: seat=1, total_point=2, part_point_1=3)
    const sc = [0, 0, 0, 0, 0, 0, 0, 0];
    const result = psub(head, 12);
    if (result) {
      for (const p of psubs(result, 1)) {
        const seat = pint(p, 1);
        if (seat >= 0 && seat < 4) {
          sc[2 * seat] = pint(p, 3);
          sc[2 * seat + 1] = pint(p, 2) / 1000;
        }
      }
    }
    return {
      uuid: pstr(head, 1),
      endTime: pint(head, 3),
      data: one(res, 4),
      dataUrl: pstr(res, 5),
      mode,
      names,
      sc,
    };
  }
  function convert(dataBlob, meta) {
    const inner = decode(dataBlob); // Wrapper
    const details = decode(one(inner, 2)); // GameDetailRecords
    const version = pint(details, 2);
    let blobs;
    if (version < 210715 && details[1]) blobs = all(details, 1);
    else
      blobs = psubs(details, 3)
        .map((a) => one(a, 3))
        .filter(Boolean);

    const parser = new GameParser();
    for (const blob of blobs) {
      const w = decode(blob);
      const name = pstr(w, 1).replace(/^\.lq\./, "");
      const body = one(w, 2);
      parser.feed(name, body ? decode(body) : {});
    }
    const log = parser.kyokus.map(dumpKyoku);
    const disp = (meta.mode === 1 ? "東" : "南") + "喰赤"; // display only
    const ts = meta.endTime ? new Date(meta.endTime * 1000).toISOString().slice(0, 19).replace("T", " ") : "";
    return {
      ver: "2.3",
      ref: meta.uuid,
      ratingc: "PF4",
      rule: { disp, aka: 1 }, // matches honvl's NAGA-accepted shape
      lobby: 0,
      dan: ["", "", "", ""],
      rate: [0, 0, 0, 0],
      sx: ["C", "C", "C", "C"],
      name: meta.names || ["AI", "AI", "AI", "AI"],
      sc: meta.sc || [0, 0, 0, 0, 0, 0, 0, 0],
      title: [disp, ts],
      log,
    };
  }
  function recordToTenhou(resBytes) {
    // sync path (inline data); used by tests
    const r = decodeRecord(resBytes);
    if (!r.data) throw new Error("record returned a data_url; use the async path");
    return convert(r.data, r);
  }
  function toNagaCustom(t) {
    return t.log.map((round) => ({ title: t.title, name: t.name, rule: t.rule, log: [round] }));
  }
  // One tenhou.net/5 URL per round, newline-separated — the format NAGA's
  // custom-game order form accepts when a log is pasted in by hand.
  function toNagaText(haihus) {
    return haihus.map((h) => "https://tenhou.net/5/#json=" + JSON.stringify(h)).join("\n");
  }

  // expose pure core for testing
  window.__majsoulNaga = { decode, decodeRecord, convert, recordToTenhou, toNagaCustom, toNagaText };

  // ---- NAGA submit (uses your NAGA browser session) ---------------------
  function gmCookieList(details) {
    return new Promise((resolve) => {
      if (typeof GM_cookie === "undefined" || !GM_cookie.list) return resolve(null);
      try {
        GM_cookie.list(details, (cookies) => resolve(cookies || null));
      } catch (_) {
        resolve(null);
      }
    });
  }
  function gmGetRaw(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: "GET", url, onload: resolve, onerror: reject });
    });
  }
  // GM_xmlhttpRequest sends your NAGA cookies automatically; this only needs the
  // csrftoken *value* (to echo as csrfmiddlewaretoken / X-CSRFToken).
  async function getCsrfToken() {
    for (const details of [
      { url: NAGA + "/", name: "csrftoken" },
      { domain: "naga.dmv.nico", name: "csrftoken" },
    ]) {
      const cookies = await gmCookieList(details);
      const hit = cookies && cookies.find((c) => c.name === "csrftoken");
      if (hit && hit.value) {
        log("csrftoken via GM_cookie");
        return hit.value;
      }
    }
    // Fallback: a GET sets/returns csrftoken via Set-Cookie (Django ensure_csrf_cookie)
    try {
      const r = await gmGetRaw(NAGA + "/naga_report/order_form/");
      const m = /csrftoken=([^;\s,]+)/.exec(r.responseHeaders || "");
      if (m) {
        log("csrftoken via Set-Cookie");
        return m[1];
      }
    } catch (_) {}
    return null;
  }
  function gmPost(url, formBody, csrf) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        data: formBody,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-CSRFToken": csrf,
          "X-Requested-With": "XMLHttpRequest",
        },
        onload: (r) => resolve(r),
        onerror: reject,
      });
    });
  }
  function gmGet(url) {
    // fetch a record data_url as bytes (cross-origin via GM)
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        onload: (r) => resolve(new Uint8Array(r.response)),
        onerror: reject,
      });
    });
  }
  async function submitToNaga(haihus, seat, gameType) {
    const csrf = await getCsrfToken();
    if (!csrf) throw new Error("couldn't read NAGA csrftoken — open naga.dmv.nico, log in, then reload");
    const form = new URLSearchParams();
    form.set("json_data", JSON.stringify(haihus));
    form.set("seat", String(seat));
    form.set("player_types", PLAYER_TYPES);
    form.set("game_type", String(gameType)); // 0 = 半荘/South, 1 = 東風/East
    form.set("csrfmiddlewaretoken", csrf);
    const r = await gmPost(NAGA + "/naga_report/api/custom_haihu_analyze/", form.toString(), csrf);
    let body;
    try {
      body = JSON.parse(r.responseText);
    } catch {
      body = r.responseText;
    }
    if (r.status !== 200 || (body && body.status && body.status >= 400)) {
      throw new Error("NAGA submit failed: HTTP " + r.status + " " + JSON.stringify(body).slice(0, 200));
    }
    return body;
  }

  // ---- capture via WebSocket hook ---------------------------------------
  let captured = null,
    wantIndex = null,
    expecting = false;
  const REQ_MARK = ".lq.Lobby.fetchGameRecord";
  function bytesIncludeAscii(buf, s) {
    outer: for (let i = 0; i + s.length <= buf.length; i++) {
      for (let j = 0; j < s.length; j++) if (buf[i + j] !== s.charCodeAt(j)) continue outer;
      return true;
    }
    return false;
  }
  // Read the actual bytes a WebSocket.send was given, respecting typed-array
  // views (byteOffset/byteLength) — a plain `new Uint8Array(data.buffer)` would
  // read from the buffer start and misread the type/index header.
  function frameBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null; // string / Blob — not an RPC frame we parse
  }
  // A type-3 response frame is [3, idxLo, idxHi, Wrapper{data: ResGameRecord}].
  // Recognize the record by shape so we don't depend solely on index matching.
  function looksLikeRecord(wrapperBytes) {
    try {
      const resB = one(decode(wrapperBytes), 2);
      if (!resB) return false;
      const res = decode(resB);
      return !!(res[3] && (res[4] || res[5])); // head + (data or data_url)
    } catch (_) {
      return false;
    }
  }
  function installWsHook() {
    // With @grant set, the page's WebSocket lives on unsafeWindow, not the
    // sandboxed window — hook there so the game's socket is actually intercepted.
    const W = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
    const Orig = W.WebSocket;
    if (!Orig) {
      warn("no WebSocket constructor to hook");
      return;
    }
    W.WebSocket = new Proxy(Orig, {
      construct(target, args) {
        const ws = new target(...args);
        log("WebSocket hooked:", args[0]);
        const origSend = ws.send.bind(ws);
        ws.send = function (data) {
          try {
            const b = frameBytes(data);
            // cheap substring pre-check, then confirm the EXACT method name so
            // fetchGameRecordList / ...Detail (supersets of the marker) don't match
            if (
              b &&
              b[0] === 2 &&
              bytesIncludeAscii(b, REQ_MARK) &&
              pstr(decode(b.subarray(3)), 1) === REQ_MARK
            ) {
              wantIndex = b[1] | (b[2] << 8);
              expecting = true;
              captured = null;
              log("fetchGameRecord request seen (idx " + wantIndex + ")");
            }
          } catch (_) {}
          return origSend(data);
        };
        ws.addEventListener("message", (ev) => {
          const handle = (buf) => {
            if (captured || buf[0] !== 3) return;
            const wrapper = buf.subarray(3); // strip type+index -> Wrapper
            const idxMatch = wantIndex !== null && (buf[1] | (buf[2] << 8)) === wantIndex;
            if (idxMatch || (expecting && looksLikeRecord(wrapper))) {
              captured = buf.slice(3);
              expecting = false;
              log("captured record frame (" + buf.length + " bytes) — press '" + TRIGGER_KEY + "'");
            }
          };
          if (ev.data instanceof ArrayBuffer) handle(new Uint8Array(ev.data));
          else if (ev.data instanceof Blob) ev.data.arrayBuffer().then((ab) => handle(new Uint8Array(ab)));
        });
        return ws;
      },
    });
    log("WebSocket hook installed");
  }

  // captured is a Wrapper(name=".lq.ResGameRecord", data=ResGameRecord). Unwrap to ResGameRecord bytes.
  function capturedResGameRecord() {
    if (!captured) return null;
    const w = decode(captured);
    return one(w, 2) || null; // Wrapper.data = ResGameRecord
  }

  // ---- UI ---------------------------------------------------------------
  function toast(msg, ms = 4000) {
    let el = document.getElementById("__mjn_toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "__mjn_toast";
      el.style.cssText =
        "position:fixed;z-index:99999;left:50%;bottom:28px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:8px;font:14px/1.4 sans-serif;max-width:80vw;box-shadow:0 2px 10px rgba(0,0,0,.4)";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.style.opacity = "0"), ms);
  }
  // Building the payload means awaiting the record fetch, so by the time there
  // is text to copy the keypress's transient user activation is gone and
  // navigator.clipboard.writeText is rejected (it also throws outright while
  // the game canvas holds focus). GM_setClipboard has neither restriction, so
  // it is the real path here; the rest only matter for an install running
  // without the @grant.
  async function copyToClipboard(text) {
    if (typeof GM_setClipboard !== "undefined") {
      try {
        GM_setClipboard(text, { type: "text", mimetype: "text/plain" });
        return true;
      } catch (e) {
        warn("GM_setClipboard failed", e);
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      warn("navigator.clipboard.writeText failed", e);
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      warn("execCommand copy failed", e);
      return false;
    }
  }
  async function run() {
    try {
      const resBytes = capturedResGameRecord();
      if (!resBytes) {
        toast(
          "No replay captured yet — open (or reload) a 4-player replay, then press '" + TRIGGER_KEY + "'.",
        );
        return;
      }
      toast("Converting…");
      const rec = decodeRecord(resBytes);
      let blob = rec.data;
      if (!blob && rec.dataUrl) {
        toast("Fetching record…");
        blob = await gmGet(rec.dataUrl);
      }
      if (!blob) throw new Error("record had neither inline data nor a data_url");
      const tenhou = convert(blob, rec);

      // game_type for NAGA: 1 = 東風/East, 0 = 半荘/South. Prefer the decoded mode;
      // fall back to whether any South round (kyoku >= 4) appears.
      const east = rec.mode === 1 || (rec.mode === 0 && !tenhou.log.some((r) => r[0][0] >= 4));
      const gameType = east ? 1 : 0;

      // Decode verification — inspect these in DevTools to confirm conversion.
      log("decoded " + tenhou.log.length + " rounds; ref=" + tenhou.ref + "; game_type=" + gameType);
      log("round 0 (tenhou.net/6):", JSON.stringify(tenhou.log[0]));
      log("full tenhou log object:", tenhou);
      log(
        "paste to verify in a viewer:",
        "https://tenhou.net/6/#json=" + encodeURIComponent(JSON.stringify(tenhou)),
      );
      if (typeof unsafeWindow !== "undefined" && unsafeWindow) unsafeWindow.__mjnLastTenhou = tenhou;

      const haihus = toNagaCustom(tenhou);
      const nagaText = toNagaText(haihus);
      const copied = await copyToClipboard(nagaText);
      if (copied) log("copied NAGA log to clipboard (" + haihus.length + " rounds)");
      else log("clipboard copy failed — paste this into the NAGA order form:", nagaText);

      const status = copied ? "copied to clipboard" : "clipboard blocked (log in console)";
      toast(`Decoded ${tenhou.log.length} rounds — ${status}; submitting to NAGA…`, 8000);
      const res = await submitToNaga(haihus, 0, gameType);
      toast("Submitted to NAGA ✓ — check your reports at naga.dmv.nico", 8000);
      log("submitted", res);
    } catch (e) {
      toast("Error: " + e.message, 8000);
      logError(e);
    }
  }

  installWsHook();
  document.addEventListener("keydown", (e) => {
    if ((e.key === TRIGGER_KEY || e.key === TRIGGER_KEY.toUpperCase()) && !e.repeat) run();
  });
  log("loaded; open a 4-player replay and press '" + TRIGGER_KEY + "'.");
})();
