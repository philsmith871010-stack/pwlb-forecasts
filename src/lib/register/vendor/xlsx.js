// @ts-nocheck
/* VENDORED from pwlbtoday-tms/register/src/xlsx.js (sha256 124a9c081ea3f56a) by scripts/sync-register.mjs.
   Do not edit here: change it there and re-sync, so both tools read registers identically. */
/* ===========================================================================
 * READING THE REGISTER WORKBOOK, WITH NO LIBRARY.
 *
 * An .xlsx is a zip of XML. The browser inflates natively (DecompressionStream,
 * Chrome 80, Edge 80, Safari 16.4, Firefox 113; Node 18 for the tests), and
 * the XML Excel writes is regular enough for a small parser of its own. So
 * the page stays what the report tool is: one file, no dependency, nothing
 * fetched. Only the cached values are read — a workbook saved by Excel has
 * every formula's result in it — so the file must have been saved by Excel
 * (or LibreOffice), not written by a script that leaves formulas unevaluated.
 *
 * readWorkbook(bytes) -> { sheets: {name: Map<"B4", {v, kind}>}, tables: [...], names: {...} }
 *   kind is "string" | "number" | "date" | "percent" | "bool"; a date's v is a
 *   JS Date (UTC midnight), a percent's v the fraction (0.0425 for 4.25%).
 * ======================================================================== */
const XL = (() => {
  const dec = new TextDecoder("utf-8");
  const text = u8 => dec.decode(u8);
  const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
  const attr = (tag, name) => { const m = new RegExp("\\s" + name.replace(":", "\\:") + '="([^"]*)"').exec(tag); return m ? unesc(m[1]) : null; };
  const tags = (xml, name) => xml.match(new RegExp("<" + name + "\\b[^>]*?(?:/>|>[\\s\\S]*?</" + name + ">)", "g")) || [];
  const inner = (tag, name) => { const m = new RegExp("<" + name + "\\b[^>]*>([\\s\\S]*?)</" + name + ">").exec(tag); return m ? m[1] : null; };

  async function inflateRaw(bytes){
    const ds = new DecompressionStream("deflate-raw");
    const resp = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await resp.arrayBuffer());
  }
  /* The zip: find the central directory from its end record, then each
     entry's data through its local header. Sizes come from the central
     directory, which is right even when the local header deferred them. */
  async function unzip(buf){
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for(let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--){
      if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
    }
    if(eocd < 0) throw new Error("This is not a zip file, so not an .xlsx");
    const n = dv.getUint16(eocd + 10, true), cd = dv.getUint32(eocd + 16, true);
    const out = {}; let p = cd;
    for(let k = 0; k < n; k++){
      if(dv.getUint32(p, true) !== 0x02014b50) throw new Error("The zip's directory is damaged");
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = text(u8.subarray(p + 46, p + 46 + nlen));
      const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnlen + lelen;
      const data = u8.subarray(start, start + csize);
      if(method === 0) out[name] = data;
      else if(method === 8) out[name] = await inflateRaw(data);
      else throw new Error("Unsupported compression in " + name);
      p += 46 + nlen + elen + clen;
    }
    return out;
  }

  const colIndex = letters => { let n = 0; for(const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
  const colLetters = n => { let s = ""; while(n > 0){ const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const ref = a => { const m = /^([A-Z]+)(\d+)$/.exec(a); return m ? {col: colIndex(m[1]), row: +m[2]} : null; };

  /* Which styles are dates, which percentages: the built-in number formats
     Excel reserves, plus any custom code with a day, month or year in it. */
  function styleKinds(stylesXml){
    const custom = {};
    tags(stylesXml || "", "numFmt").forEach(t => { custom[attr(t, "numFmtId")] = attr(t, "formatCode") || ""; });
    const xfs = inner(stylesXml || "", "cellXfs") || "";
    const kinds = tags(xfs, "xf").map(t => {
      const id = +(attr(t, "numFmtId") || 0);
      if((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return "date";
      if(id === 9 || id === 10) return "percent";
      const code = custom[String(id)];
      if(code == null) return "number";
      const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
      if(/%/.test(bare)) return "percent";
      if(/[dmyh]/i.test(bare) && !/[#0]/.test(bare)) return "date";
      if(/[dmy]/i.test(bare)) return "date";
      return "number";
    });
    return kinds;
  }
  /* A serial's whole days are the date; a time of day is dropped, not
     rounded into tomorrow (24/12/2026 18:00 read as 25/12/2026). A workbook
     on the 1904 date system counts from 1 January 1904, 1,462 days on (audit
     D9, 5 October 2026). */
  const EPOCH = Date.UTC(1899, 11, 30);
  const serialToDate = (n, d1904) => new Date(EPOCH + (Math.floor(n) + (d1904 ? 1462 : 0)) * 86400000);
  /* A date cell written as text the ISO way (t="d", as openpyxl's iso_dates
     and other writers do): its calendar day, or nothing if it is not one. */
  const isoToDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "").trim()); if(!m) return null; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return isFinite(d.getTime()) && d.getUTCDate() === +m[3] ? d : null; };

  function sharedStrings(xml){
    return tags(xml || "", "si").map(si =>
      (si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => unesc(t.replace(/^<t\b[^>]*>/, "").replace(/<\/t>$/, ""))).join(""));
  }

  function parseSheet(xml, strings, kinds, d1904){
    const cells = new Map();
    const sd = inner(xml, "sheetData") || "";
    tags(sd, "c").forEach(c => {
      const a = attr(c, "r"); if(!a) return;
      const t = attr(c, "t"), s = attr(c, "s");
      const v = inner(c, "v");
      let out = null;
      if(t === "s"){ if(v != null) out = {v: strings[+v] ?? "", kind: "string"}; }
      else if(t === "str"){ out = {v: unesc(v || ""), kind: "string"}; }
      else if(t === "inlineStr"){ const is = inner(c, "is") || ""; out = {v: (is.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map(x => unesc(x.replace(/^<t\b[^>]*>/, "").replace(/<\/t>$/, ""))).join(""), kind: "string"}; }
      else if(t === "b"){ if(v != null) out = {v: v === "1", kind: "bool"}; }
      else if(t === "e"){ out = {v: unesc(v || ""), kind: "error"}; }
      else if(t === "d"){ const d = isoToDate(v); out = d ? {v: d, kind: "date"} : {v: unesc(v || ""), kind: "string"}; }
      else if(v != null){
        const n = +v, kind = s != null ? (kinds[+s] || "number") : "number";
        out = kind === "date" ? {v: serialToDate(n, d1904), kind: "date"} : {v: n, kind};
      }
      if(out) cells.set(a, out);
    });
    /* Rows hidden in Excel are still rows: the reader says so, row by row. */
    const hidden = new Set();
    (sd.match(/<row\b[^>]*\bhidden="(?:1|true)"[^>]*>/g) || []).forEach(t => { const r = attr(t, "r"); if(r) hidden.add(+r); });
    cells.hiddenRows = hidden;
    return cells;
  }

  function relsOf(files, path){
    // xl/workbook.xml -> xl/_rels/workbook.xml.rels ; xl/worksheets/sheet1.xml -> xl/worksheets/_rels/sheet1.xml.rels
    const i = path.lastIndexOf("/");
    const rp = path.slice(0, i) + "/_rels/" + path.slice(i + 1) + ".rels";
    const xml = files[rp] ? text(files[rp]) : "";
    const base = path.slice(0, i);
    const out = {};
    tags(xml, "Relationship").forEach(r => {
      let target = attr(r, "Target") || "";
      if(target.startsWith("/")) target = target.slice(1);
      else { const parts = (base + "/" + target).split("/"); const st = []; for(const p of parts){ if(p === "..") st.pop(); else if(p !== ".") st.push(p); } target = st.join("/"); }
      out[attr(r, "Id")] = {target, type: (attr(r, "Type") || "").split("/").pop()};
    });
    return out;
  }

  async function readWorkbook(bytes){
    const files = await unzip(bytes);
    if(!files["xl/workbook.xml"]) throw new Error("This file has no workbook in it — is it an .xlsx?");
    const wbXml = text(files["xl/workbook.xml"]);
    const wbRels = relsOf(files, "xl/workbook.xml");
    const strings = sharedStrings(files["xl/sharedStrings.xml"] ? text(files["xl/sharedStrings.xml"]) : "");
    const kinds = styleKinds(files["xl/styles.xml"] ? text(files["xl/styles.xml"]) : "");
    const sheets = {}, tables = [], order = [];
    const pr = tags(wbXml, "workbookPr")[0] || "", d1904 = /^(1|true)$/i.test(attr(pr, "date1904") || "");
    tags(wbXml, "sheet").forEach(s => {
      const name = attr(s, "name"), rid = attr(s, "r:id");
      const rel = wbRels[rid]; if(!rel || !files[rel.target]) return;
      const xml = text(files[rel.target]);
      sheets[name] = parseSheet(xml, strings, kinds, d1904); order.push(name);
      const srels = relsOf(files, rel.target);
      Object.values(srels).filter(r => r.type === "table" && files[r.target]).forEach(r => {
        const tx = text(files[r.target]);
        const head = /<table\b[^>]*>/.exec(tx); if(!head) return;
        /* A table with Excel's Total Row on (Table Design → Total Row) has
           its totals as the last row of its range: the count says how many
           rows at the foot are totals, not deals (audit D7). */
        tables.push({name: attr(head[0], "displayName") || attr(head[0], "name"), sheet: name,
          ref: attr(head[0], "ref"), totals: +(attr(head[0], "totalsRowCount") || 0) || 0, columns: tags(tx, "tableColumn").map(c => attr(c, "name"))});
      });
    });
    const names = {};
    /* Excel's own names (_xlnm.Print_Area, _xlnm.Print_Titles: one per sheet
       that sets them) are page setup, not the workbook's names, and would
       overwrite one another here. */
    tags(wbXml, "definedName").forEach(d => { const n = attr(d, "name"), v = inner(d, "definedName"); if(n && v && !/^_xlnm\./.test(n)) names[n] = unesc(v); });
    return {sheets, order, tables, names, date1904: d1904};
  }

  /* A table's rows as objects keyed by header, blank rows skipped, with the
     sheet row number kept for saying where a problem is.

     THE READ ROUND THE ACCIDENTS (Phil, 3 October 2026: "users can't break
     things that compromise the upload"). The table is the contract, but a
     council can convert it to a range, rename it, type rows beneath it or
     retitle a header, and the workbook has to read anyway and say what was
     found. So: a table that is there is read as before, then any rows typed
     beneath it, however far down, marked `_outside` — the workbook's own sums
     reach its capacity row, and a row two hundred rows down that the
     workbook counted and the reader did not was a different total with no
     word said (audit B9, 5 October 2026); a table that
     is not there is looked for by its headers, on the sheet it belongs on
     and then on every sheet; and a header that has grown a unit, lost its
     case or taken a common synonym still names its column. `expect` is what
     the caller knows the table to be: {sheet, headers, aliases}. The keys of
     each row are the expected header names where one matched, the raw text
     where none did. */
  const normH = s => String(s == null ? "" : s).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  function mapHeads(raw, expect){
    if(!expect || !expect.headers) return raw.slice();
    const want = expect.headers.map(h => ({h, n: normH(h), al: ((expect.aliases || {})[h] || []).map(normH)}));
    return raw.map(h => { const n = normH(h); const hit = want.find(w => w.n === n) || want.find(w => w.al.indexOf(n) >= 0); return hit ? hit.h : h; });
  }
  function scanRows(cells, col0, from, to, keys, stopAtBlanks){
    const rows = []; let blank = 0;
    for(let r = from; r <= to; r++){
      const o = {_row: r}; let any = false;
      keys.forEach((k, i) => { const cell = cells.get(colLetters(col0 + i) + r); if(k === "") return; o[k] = cell || null; if(cell && cell.v !== "" && cell.v != null) any = true; });
      if(any){ rows.push(o); blank = 0; }
      else if(stopAtBlanks && ++blank >= 5) break;
    }
    return rows;
  }
  function tableRows(wb, tableName, expect){
    const t = wb.tables.find(x => x.name === tableName);
    if(t){
      const cells = wb.sheets[t.sheet]; if(!cells) return null;
      const [a, b] = t.ref.split(":"), r0 = ref(a), r1 = ref(b || a);
      const raw = [];
      for(let c = r0.col; c <= r1.col; c++){ const h = cells.get(colLetters(c) + r0.row); raw.push(h ? String(h.v).trim() : t.columns[c - r0.col] || ""); }
      const keys = mapHeads(raw, expect);
      const foot = Math.max(0, t.totals || 0), last = r1.row - foot;
      const rows = scanRows(cells, r0.col, r0.row + 1, last, keys, false);
      let maxRow = r1.row; for(const a of cells.keys()){ const p = ref(a); if(p && p.row > maxRow && p.col >= r0.col && p.col <= r1.col) maxRow = p.row; }
      const beneath = scanRows(cells, r0.col, r1.row + 1, maxRow, keys, false);
      beneath.forEach(o => { o._outside = true; });
      return {table: t, headers: raw, keys, rows: rows.concat(beneath), outside: beneath.length, sheet: t.sheet, headerRow: r0.row, fallback: false, hidden: cells.hiddenRows || new Set()};
    }
    if(!expect || !expect.headers) return null;
    const names = [expect.sheet].concat((wb.order || []).filter(n => n !== expect.sheet));
    for(const name of names){
      const cells = wb.sheets[name]; if(!cells) continue;
      for(let r = 1; r <= 15; r++){
        const found = [];
        for(let c = 1; c <= 40; c++){ const h = cells.get(colLetters(c) + r); if(h && h.kind === "string" && String(h.v).trim()) found.push({c, raw: String(h.v).trim()}); }
        if(found.length < 3) continue;
        const hits = mapHeads(found.map(f => f.raw), expect).filter(k => expect.headers.indexOf(k) >= 0).length;
        if(hits < 3) continue;
        const c0 = found[0].c, c1 = found[found.length - 1].c, raw = [];
        for(let c = c0; c <= c1; c++){ const h = cells.get(colLetters(c) + r); raw.push(h ? String(h.v).trim() : ""); }
        const keys = mapHeads(raw, expect);
        const rows = scanRows(cells, c0, r + 1, r + 1000, keys, true);
        return {table: null, headers: raw, keys, rows, outside: 0, sheet: name, headerRow: r, fallback: true, hidden: cells.hiddenRows || new Set()};
      }
    }
    return null;
  }
  /* A defined name's single cell, e.g. AsAt -> Settings!$B$4. */
  function named(wb, name){
    const v = wb.names[name]; if(!v) return null;
    const m = /^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)$/.exec(v); if(!m) return null;
    const cells = wb.sheets[m[1]]; if(!cells) return null;
    return cells.get(m[2] + m[3]) || null;
  }
  return {readWorkbook, tableRows, named, unzip, colLetters, ref, normH};
})();

export default XL;
