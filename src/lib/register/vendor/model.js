// @ts-nocheck
/* VENDORED from pwlbtoday-tms/register/src/model.js (sha256 5caa132edc016653) by scripts/sync-register.mjs.
   Do not edit here: change it there and re-sync, so both tools read registers identically. */
import XL from './xlsx.js';
/* ===========================================================================
 * THE REGISTER: what the workbook means, and the sums the page draws.
 *
 * Strict about the vocabulary (the drop-down lists in the workbook), lenient
 * about free text. A row with a problem is kept and flagged, so the replica
 * shows exactly what was read and where it went wrong; it is left out of the
 * sums only when the sum could not use it (no amount, no maturity).
 * The vocabulary here mirrors the workbook's Lists sheet: both are the
 * contract, and a benchmarking service later would aggregate on these words.
 *
 * Four tables: TermInvestments, CallAccounts, Loans, PooledFunds. A term
 * investment's "nominal" is its Face value where given (a T-bill or gilt
 * bought at a discount) and its Principal otherwise, and the investment
 * figures are in nominal — what comes back at maturity. A loan's Principal
 * is what is outstanding at the as-at date, and its repayment schedule is
 * built forward from there by its profile.
 * ======================================================================== */
const REG = (() => {
  const TEMPLATE_VERSION = 3;
  const VOCAB = {
    termTypes: ["Fixed deposit", "Certificate of deposit", "Treasury bill", "Gilt", "Bond", "Loan to local authority", "Other"],
    counterpartyTypes: ["UK bank", "Overseas bank", "Building society", "Local authority", "UK Government", "Money market fund", "Pooled fund", "Other"],
    hra: ["None", "One pool", "Two pools"],
    callTypes: ["Call account", "Notice account", "Money market fund", "Deposit account"],
    loanTypes: ["PWLB fixed", "LOBO", "Market loan", "Local authority loan", "Temporary borrowing", "Other"],   /* no "PWLB variable" (Phil, 3 October 2026) */
    lenderTypes: ["PWLB", "Local authority", "UK bank", "Overseas bank", "Other"],
    profiles: ["Maturity", "EIP", "Annuity"],
    frequencies: ["Half-yearly", "Annual", "Quarterly"],
    funds: ["General Fund", "HRA"],
    fundTypes: ["Property", "Multi-asset", "Equity income", "Bond", "Cash plus", "Other"]
  };
  const PER_YEAR = {"Half-yearly": 2, "Annual": 1, "Quarterly": 4};
  /* What each table is known to be: the sheet it belongs on, its headers, and
     the words a council's own sheet might head a column with instead. The
     parser reads a table that is still there as before; one that has been
     converted to a range or renamed is found by these headers; a header with
     a unit added or a synonym still names its column. REQUIRED are the
     columns without which the rows cannot count at all. */
  const EXPECT = {
    TermInvestments: {sheet: "Term investments", headers: ["Type", "Counterparty", "Counterparty type", "Principal", "Start date", "Maturity date", "Rate", "Face value", "Carrying value", "Rating", "Notes"],
      aliases: {"Counterparty": ["counterparty name", "institution", "borrower", "bank"], "Counterparty type": ["type of counterparty", "sector"], "Principal": ["amount", "principal amount", "deposit", "sum"],
        "Start date": ["start", "trade date", "value date", "deal date", "from"], "Maturity date": ["maturity", "end date", "to", "matures"], "Rate": ["interest rate", "coupon", "yield", "rate pc"],
        "Face value": ["nominal", "nominal value", "face"], "Carrying value": ["carrying amount", "book value"]}},
    CallAccounts: {sheet: "Call accounts and MMFs", headers: ["Type", "Counterparty", "Counterparty type", "Balance", "Rate", "Notice days", "Rating", "Average balance", "Average rate", "Notes"],
      aliases: {"Counterparty": ["counterparty name", "institution", "fund", "bank"], "Counterparty type": ["type of counterparty", "sector"], "Balance": ["amount", "balance held", "principal"], "Rate": ["interest rate", "yield"],
        "Notice days": ["notice", "notice period", "days notice"], "Average balance": ["average"]}},
    Loans: {sheet: "Loans", headers: ["Type", "Lender", "Lender type", "Principal", "Start date", "Maturity date", "Rate", "Profile", "Frequency", "First repayment date", "Fund", "Next call date", "Notes"],
      aliases: {"Lender": ["counterparty", "lender name"], "Lender type": ["type of lender"], "Principal": ["amount", "outstanding", "principal outstanding", "balance", "balance outstanding"],
        "Start date": ["start", "advance date", "drawdown date", "from"], "Maturity date": ["maturity", "end date", "to", "matures"], "Rate": ["interest rate", "coupon", "rate pc"],
        "Profile": ["repayment profile", "repayment type", "type of repayment", "repayment"], "Frequency": ["payment frequency", "repayment frequency"], "First repayment date": ["first repayment", "first payment date", "first payment"],
        "Next call date": ["next call", "call date", "next option date", "option date"]}},
    PooledFunds: {sheet: "Pooled funds", headers: ["Fund name", "Fund type", "Carrying value", "Latest value", "Current rate", "Purchase date", "Average value", "Average rate", "Notes"],
      aliases: {"Fund name": ["fund", "name"], "Fund type": ["type"], "Carrying value": ["carrying amount", "book value", "cost"], "Latest value": ["market value", "valuation", "latest valuation", "value"],
        "Current rate": ["rate", "yield", "distribution yield", "income rate"], "Purchase date": ["purchased", "date purchased", "start date"], "Average value": ["average"]}}
  };
  const REQUIRED = {TermInvestments: ["Type", "Counterparty", "Principal", "Maturity date"], CallAccounts: ["Type", "Counterparty", "Balance"], Loans: ["Type", "Lender", "Principal", "Maturity date"], PooledFunds: ["Fund name", "Carrying value"]};
  const norm = s => String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase();
  const pick = (list, v) => list.find(x => norm(x) === norm(v)) || null;
  const str = c => c && c.v != null ? String(c.v).trim() : "";
  const num = c => c && c.kind !== "string" && typeof c.v === "number" ? c.v : (c && typeof c.v === "string" && c.v.trim() !== "" && !isNaN(+c.v.replace(/[,£%\s]/g, "")) ? +c.v.replace(/[,£%\s]/g, "") : null);
  /* A workbook saved on the 1904 date system counts its serials from 1
     January 1904, 1,462 days on from 1900's: set for the length of a read
     (readRegister), so a serial typed into a General-format cell reads as
     the same day the dated cells do (audit D9, 5 October 2026). */
  let SHIFT1904 = 0;
  const validYMD = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  /* A date is a calendar day: a time of day is dropped, never rounded into
     the next day (24/12/2026 18:00 read as 25/12/2026); a date object that
     is not a date (an unreadable cell) is no date at all; a date typed as
     text must be a real day — 31/02/2027 and 03/31/2027 (US order) are not,
     and were read as 03/03/2027 and 03/07/2029 (audit D9, 5 October 2026). */
  const date = c => {
    if(!c) return null;
    if(c.v instanceof Date){ const t = c.v.getTime(); return isFinite(t) ? new Date(Math.floor(t / 86400000) * 86400000) : null; }
    if(typeof c.v === "number" && c.v > 20000 && c.v < 80000) return new Date(Date.UTC(1899, 11, 30) + (Math.floor(c.v) + SHIFT1904) * 86400000);
    if(typeof c.v === "string"){
      const t = c.v.trim();
      let m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t); if(m) return validYMD(+m[3], +m[2], +m[1]) ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : null;
      m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if(m) return validYMD(+m[1], +m[2], +m[3]) ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    }
    return null;
  };
  /* A date cell read for a row, flagged when it was typed as text: the
     workbook marks it red, and a date in words is a guess the reader says
     it made. */
  const dateIn = (o, r, col) => {
    const c = r[col], d = date(c);
    if(d && c && c.kind === "string") o.issues.push(`${col} was typed as text ("${String(c.v).trim()}"): read as ${dmy(d)}`);
    return d;
  };
  /* A rate cell (audit B8 and D8, 5 October 2026: one rule for the reader
     and the workbook's rate mirrors). A number below 1 is the fraction (a
     percentage-formatted 4.10% holds 0.041); a number of 1 or more is a
     percentage typed as a number, 4.1 for 4.1%, whatever the cell's format
     — the workbook reads it the same way; text with a % sign is a
     percentage whatever its size, so "0.5%" is half a per cent, not 50%. */
  const rate = c => {
    if(!c) return null;
    const n = num(c); if(n == null) return null;
    if(c.kind === "string" && /%/.test(String(c.v))) return n / 100;
    return n >= 1 ? n / 100 : n;
  };
  /* Outside 0% to 20%, the workbook's own validation range, a rate is
     flagged: a plain 0.75 meant as 0.75% reads as 75%. */
  const rateRange = (o, v, col) => { if(v != null && (v < 0 || v > 0.2)) o.issues.push(`${col} ${(v * 100).toFixed(2)}% is outside 0% to 20%`); };
  const dmy = d => d ? `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}` : "";
  const money = n => n == null ? "" : (n < 0 ? "(£" : "£") + Math.round(Math.abs(n)).toLocaleString("en-GB") + (n < 0 ? ")" : "");   /* a negative in brackets, as the paper writes them: "£-8,860,000" read badly */
  const pct = r => r == null ? "" : (r * 100).toFixed(2) + "%";
  const years = (a, b) => (b - a) / 86400000 / 365.25;

  /* A vocabulary column: the raw text kept, the list word found or flagged. */
  function vocab(o, r, col, list, key, required){
    const raw = str(r[col]); o[key + "Raw"] = raw; o[key] = pick(list, raw);
    if(!o[key]){
      if(raw) o.issues.push(`${col} "${raw}" is not one of the list`);
      else if(required) o.issues.push(`${col} is blank`);
    }
  }

  /* What follows from a row's fields, for a row read from the workbook and
     for one brought back from a report's snapshot alike. A deal matured, or
     a loan repaid, on or before the as-at date is history: not a holding, not
     a flag — it is what the activity figures are made of.
     HELD MEANS STARTED AND NOT YET MATURED: start on or before the as-at
     date, maturity after it, for deals and loans alike (audit A3, B2, D1,
     5 October 2026). A deal or loan dated to start after the as-at date is
     forward: agreed, not yet held, so not invested or owed at that date; a
     forward loan still runs off from its start, so it has a schedule and
     the year ends after its start count it (runsOff). A blank start is
     taken as held. */
  const isForward = (o, asAt) => !!(o.start && asAt && o.start > asAt && o.maturity && o.maturity > asAt);
  const deriveTerm = (o, asAt) => { o.nominal = o.faceValue > 0 ? o.faceValue : o.principal; o.history = !!(o.maturity && asAt && o.maturity <= asAt); o.forward = isForward(o, asAt); o.counts = o.nominal > 0 && !!o.maturity && !o.history && !o.forward; o.runsOff = o.counts || (o.forward && o.nominal > 0); return o; };
  const deriveCall = o => { o.counts = o.balance > 0; o.history = false; return o; };
  const deriveLoan = (o, asAt) => { o.history = !!(o.maturity && asAt && o.maturity <= asAt); o.forward = isForward(o, asAt);
    const valid = o.principal > 0 && !!o.maturity && !o.history && !(o.profile !== "Maturity" && !o.frequency);
    o.counts = valid && !o.forward; o.runsOff = valid; o.schedule = o.runsOff && asAt ? schedule(o, asAt) : [];
    /* What the loan was raised at (audit A2, D3): the principal outstanding
       now plus the instalments paid since it was raised, rebuilt backward
       as pastSchedule does; for any other loan its Principal. */
    o.raised = o.principal > 0 && o.counts && asAt ? o.principal + pastSchedule(o, asAt).reduce((t, p) => t + p.amount, 0) : o.principal;
    return o; };
  /* A fund with a latest value but no carrying value is flagged and left out
     of every pooled-fund figure, in the tool and the workbook alike (audit B12). */
  const deriveFund = o => { o.counts = o.carryingValue > 0; o.history = false; return o; };

  function readRegister(wb){
    SHIFT1904 = wb && wb.date1904 ? 1462 : 0;
    try{ return readRegister1(wb); } finally { SHIFT1904 = 0; }
  }
  function readRegister1(wb){
    const issues = [];
    /* A setting is its defined name; with the name gone (a row deleted on
       Settings, the sheet rebuilt by hand) it is the cell beside its label,
       on Settings first and then on any sheet, and the read says so. */
    const setting = (name, label) => {
      const c = XL.named(wb, name); if(c) return c;
      for(const sheet of ["Settings"].concat((wb.order || []).filter(n => n !== "Settings"))){
        const cells = wb.sheets[sheet]; if(!cells) continue;
        for(const [addr, cell] of cells){
          if(!cell || cell.kind !== "string" || norm(cell.v) !== norm(label)) continue;
          const p = XL.ref(addr); if(!p) continue;
          const v = cells.get(XL.colLetters(p.col + 1) + p.row);
          if(v && v.v !== "" && v.v != null){ issues.push(`Settings: the ${name} name is missing (a row deleted, or the sheet rebuilt); the cell beside "${label}" on ${sheet} was read instead.`); return v; }
        }
      }
      return null;
    };
    const asAt = date(setting("AsAt", "As at"));
    if(!asAt) issues.push("Settings: the As at date is missing or not a date.");
    if(wb && wb.date1904) issues.push("The workbook uses the 1904 date system (Excel for Mac's old default): its dates were read on that system.");
    const hraRaw = str(setting("HRA", "HRA")), hra = pick(VOCAB.hra, hraRaw);
    if(!hra) issues.push(`Settings: HRA is "${hraRaw || "blank"}"; it should be None, One pool or Two pools.`);
    const vcell = setting("TemplateVersion", "Template version"), version = vcell ? num(vcell) : null;
    if(version !== TEMPLATE_VERSION) issues.push(`Settings: template version ${version == null ? "is missing" : "is " + version}; this page reads version ${TEMPLATE_VERSION}` + (version === 2 ? " (the period on Settings, and the averages over it, are new)." : "."));
    const twoPools = hra === "Two pools";
    /* The period the averages cover: from the date on Settings to the as-at
       date; 1 April of the as-at date's financial year when none is given. */
    let periodFrom = date(setting("PeriodFrom", "Period from"));
    if(periodFrom && asAt && periodFrom >= asAt){ issues.push("Settings: Period from is not before the As at date; 1 April is used."); periodFrom = null; }

    const table = (name, each) => {
      const t = XL.tableRows(wb, name, EXPECT[name]), out = [];
      if(!t){ issues.push(`There is no ${name} table and no sheet with its headers — is this the register template?`); return out; }
      if(t.fallback) issues.push(`There is no ${name} table: the rows were read from the ${t.sheet} sheet by their headers (row ${t.headerRow}). In Excel, select the rows with their headers, Insert \u2192 Table, and name it ${name} on the Table Design tab.`);
      if(t.outside) issues.push(`${t.outside} row${t.outside === 1 ? " was" : "s were"} typed beneath the ${name} table and read anyway: drag the table's corner handle down over ${t.outside === 1 ? "it" : "them"}, so the workbook's own checks see ${t.outside === 1 ? "it" : "them"} too.`);
      const missing = REQUIRED[name].filter(h => t.keys.indexOf(h) < 0);
      if(missing.length) issues.push(`${name}: no column headed ${missing.map(h => '"' + h + '"').join(", ")} \u2014 a header was changed; put the exact words back.`);
      t.rows.forEach(r => {
        const o = {row: r._row, issues: []};
        Object.keys(r).forEach(h => { const c = r[h]; if(c && c.kind === "error") o.issues.push(`${h} is an Excel error (${c.v})`); });
        if(t.hidden.has(r._row)) o.issues.push("hidden in the workbook, and still read: delete the row to leave it out");
        if(r._outside) o.issues.push(`typed beneath the ${name} table`);
        each(o, r); out.push(o);
      });
      return out;
    };
    /* The holding sheets are in pounds. A figure below \u00a31,000 is almost
       always \u00a3m typed by habit, and five pounds of principal draws nothing. */
    const pounds = (o, v, what) => { if(v != null && v > 0 && v < 1000) o.issues.push(`${what} is below \u00a31,000 \u2014 amounts are in pounds, not \u00a3m`); };

    const termInvestments = table("TermInvestments", (o, r) => {
      vocab(o, r, "Type", VOCAB.termTypes, "type", true);
      o.counterparty = str(r["Counterparty"]); if(!o.counterparty) o.issues.push("Counterparty is blank");
      vocab(o, r, "Counterparty type", VOCAB.counterpartyTypes, "cpType", true);
      o.principal = num(r["Principal"]); if(o.principal == null || !(o.principal > 0)) o.issues.push("Principal is blank or not a positive number"); pounds(o, o.principal, "Principal");
      o.start = dateIn(o, r, "Start date"); if(!o.start) o.issues.push("Start date is missing or not a date");
      o.maturity = dateIn(o, r, "Maturity date"); if(!o.maturity) o.issues.push("Maturity date is missing or not a date");
      if(o.start && o.maturity && o.maturity <= o.start) o.issues.push("Maturity date is not after the start date");
      if(o.start && asAt && o.start > asAt && !(o.maturity && o.maturity <= o.start)) o.issues.push("Start date is after the as-at date: a forward deal, not held until it starts");
      o.rate = rate(r["Rate"]); if(o.rate == null) o.issues.push("Rate is blank"); rateRange(o, o.rate, "Rate");
      o.faceValue = num(r["Face value"]); if(o.faceValue != null && !(o.faceValue > 0)) o.issues.push("Face value is not a positive number");
      o.carryingValue = num(r["Carrying value"]);
      o.rating = str(r["Rating"]); o.notes = str(r["Notes"]);
      deriveTerm(o, asAt);
    });

    const callAccounts = table("CallAccounts", (o, r) => {
      vocab(o, r, "Type", VOCAB.callTypes, "type", true);
      o.counterparty = str(r["Counterparty"]); if(!o.counterparty) o.issues.push("Counterparty is blank");
      vocab(o, r, "Counterparty type", VOCAB.counterpartyTypes, "cpType", true);
      o.balance = num(r["Balance"]); if(o.balance == null || !(o.balance >= 0)) o.issues.push("Balance is blank or not a number"); pounds(o, o.balance, "Balance");
      o.rate = rate(r["Rate"]); if(o.rate == null) o.issues.push("Rate is blank"); rateRange(o, o.rate, "Rate");
      o.noticeDays = num(r["Notice days"]); if(o.noticeDays != null && o.noticeDays < 0) o.issues.push("Notice days is below nought");
      o.rating = str(r["Rating"]); o.notes = str(r["Notes"]);
      /* No maximum balance (6 October 2026): a workbook that still has the column reads as before, the column unread. */
      o.avgBalance = num(r["Average balance"]); o.avgRate = rate(r["Average rate"]); rateRange(o, o.avgRate, "Average rate");
      deriveCall(o);
    });

    const loans = table("Loans", (o, r) => {
      vocab(o, r, "Type", VOCAB.loanTypes, "type", true);
      o.lender = str(r["Lender"]); if(!o.lender) o.issues.push("Lender is blank");
      vocab(o, r, "Lender type", VOCAB.lenderTypes, "lenderType", true);
      o.principal = num(r["Principal"]); if(o.principal == null || !(o.principal > 0)) o.issues.push("Principal is blank or not a positive number"); pounds(o, o.principal, "Principal");
      o.start = dateIn(o, r, "Start date");
      o.maturity = dateIn(o, r, "Maturity date"); if(!o.maturity) o.issues.push("Maturity date is missing or not a date");
      if(o.start && o.maturity && o.maturity <= o.start) o.issues.push("Maturity date is not after the start date");
      if(o.start && asAt && o.start > asAt && !(o.maturity && o.maturity <= o.start)) o.issues.push("Start date is after the as-at date: forward borrowing, not owed until it starts");
      o.rate = rate(r["Rate"]); if(o.rate == null) o.issues.push("Rate is blank"); rateRange(o, o.rate, "Rate");
      vocab(o, r, "Profile", VOCAB.profiles, "profile", false);
      if(!o.profile && !o.profileRaw) o.profile = "Maturity";   /* blank means repaid at the end */
      vocab(o, r, "Frequency", VOCAB.frequencies, "frequency", false);
      o.firstRepayment = dateIn(o, r, "First repayment date");
      if(o.profile && o.profile !== "Maturity"){
        /* Half-yearly is how PWLB loans pay; a blank Frequency is taken as
           that, no flag (Phil, 3 October 2026: "assume loans have semi
           annual frequency if blank"). A blank First repayment date is not
           a fault either: the first payment date after the start on the
           cycle that ends at maturity is assumed (firstPaymentDate), the
           front-end stub PWLB loans always have. */
        if(!o.frequency && !o.frequencyRaw) o.frequency = "Half-yearly";
        else if(!o.frequency) o.issues.push(`${o.profile} needs a Frequency from the list`);
        if(o.firstRepayment && o.maturity && o.firstRepayment > o.maturity) o.issues.push("First repayment date is after the maturity date: the loan is taken as repaid in one payment at maturity");
        if(o.firstRepayment && o.start && o.firstRepayment <= o.start) o.issues.push("First repayment date is not after the start date");
      }
      vocab(o, r, "Fund", VOCAB.funds, "fund", false);
      if(twoPools && !o.fund) o.issues.push("Fund is blank, and Settings says Two pools");
      o.nextCall = dateIn(o, r, "Next call date");
      /* THE NEXT CALL (audit A8, D25, 5 October 2026; the rule the workbook
         keeps too): a LOBO is taken at its next call date only when the call
         is after the as-at date and before the maturity. A call on or before
         the as-at date is flagged and the loan runs to maturity — it was not
         called, or it would have been repaid; a call date on a loan that is
         not a LOBO is flagged and ignored. */
      if(o.type === "LOBO" && !o.nextCall) o.issues.push("A LOBO needs its Next call date");
      if(o.nextCall && o.type && o.type !== "LOBO") o.issues.push("Next call date is given, but the loan is not a LOBO: the date is ignored");
      else if(o.nextCall && asAt && o.nextCall <= asAt) o.issues.push("Next call date is on or before the as-at date: the loan is taken to run to its maturity");
      else if(o.nextCall && o.maturity && o.nextCall >= o.maturity) o.issues.push("Next call date is not before the maturity date: the maturity date is used");
      o.notes = str(r["Notes"]);
      deriveLoan(o, asAt);
    });

    const pooledFunds = table("PooledFunds", (o, r) => {
      o.name = str(r["Fund name"]); if(!o.name) o.issues.push("Fund name is blank");
      vocab(o, r, "Fund type", VOCAB.fundTypes, "fundType", true);
      o.carryingValue = num(r["Carrying value"]); if(o.carryingValue == null || !(o.carryingValue > 0)) o.issues.push("Carrying value is blank or not a positive number"); pounds(o, o.carryingValue, "Carrying value");
      o.latestValue = num(r["Latest value"]); if(o.latestValue == null) o.issues.push("Latest value is blank");
      o.rate = rate(r["Current rate"]); rateRange(o, o.rate, "Current rate");
      o.purchased = dateIn(o, r, "Purchase date");
      o.avgValue = num(r["Average value"]); o.avgRate = rate(r["Average rate"]); rateRange(o, o.avgRate, "Average rate");
      o.notes = str(r["Notes"]);
      deriveFund(o);
    });

    /* A ROW TYPED TWICE is counted twice, so it is flagged (audit D24, 5
       October 2026): the same words, amounts, dates and rate as a row above
       it. It still counts — two identical deposits can be real — but the
       reader says so, and the workbook marks it amber. */
    const twice = (rows, key) => { const seen = new Map(); rows.forEach(o => { const k = key(o); if(!k) return; if(seen.has(k)) o.issues.push(`the same as row ${seen.get(k)}: typed twice?`); else seen.set(k, o.row); }); };
    const kd = d => d ? d.getTime() : "";
    twice(termInvestments, o => o.principal > 0 ? [o.typeRaw, norm(o.counterparty), o.principal, kd(o.start), kd(o.maturity), o.rate, o.faceValue].join("|") : null);
    twice(callAccounts, o => o.balance > 0 ? [o.typeRaw, norm(o.counterparty), o.balance, o.rate, o.noticeDays].join("|") : null);
    twice(loans, o => o.principal > 0 ? [o.typeRaw, norm(o.lender), o.principal, kd(o.start), kd(o.maturity), o.rate].join("|") : null);
    twice(pooledFunds, o => o.carryingValue > 0 ? [norm(o.name), o.carryingValue, o.latestValue].join("|") : null);
    const projections = readProjections(wb, issues);
    const readiness = readReadiness(wb);
    return {asAt, hra, hraRaw, twoPools, version, periodFrom, termInvestments, callAccounts, loans, pooledFunds, projections, readiness, issues, read: new Date()};
  }

  /* ---- the workbook's own verdict ------------------------------------------
     The Ready to read panel on Start here, as Excel last calculated it: the
     status line under the title, and the checks marked ✘ with their text. A
     file saved from Excel carries the cached values; the template as built
     carries none, and then there is nothing to read (null). Read by the
     title, not the cell, so a row added above does no harm. */
  function readReadiness(wb){
    const cells = wb.sheets && wb.sheets["Start here"]; if(!cells) return null;
    for(const [addr, c] of cells){
      if(!c || c.kind !== "string" || !/^ready to read\??$/.test(norm(c.v))) continue;
      const p = XL.ref(addr); if(!p) continue;
      const st = cells.get(XL.colLetters(p.col) + (p.row + 1));
      if(!st || st.kind !== "string" || !/^(Ready|Not ready)/.test(String(st.v))) return null;
      const failed = [];
      for(let r = p.row + 2; r <= p.row + 80; r++){
        const m = cells.get(XL.colLetters(p.col) + r); if(!m || m.kind !== "string") break;
        const v = String(m.v).trim(); if(v !== "\u2714" && v !== "\u2718") break;
        if(v === "\u2718"){ const t = cells.get(XL.colLetters(p.col + 1) + r); failed.push(t && t.v != null ? String(t.v).split(" \u2014 ")[0] : `the check at row ${r}`); }
      }
      return {ready: /^Ready/.test(String(st.v)), text: String(st.v), failed};
    }
    return null;
  }

  /* ---- the projection: the report tool's figures grid, as a sheet ----------
     (Phil, 3 October 2026: "Build it"). A block per fund: a header row whose
     first cell says "Year end", its columns named as the tool's grid names
     them, then one row a year — the actual year first — read until the year
     cell is blank. Found by the header, never by position, so rows and
     columns added above or beside do no harm; the fund is the title above
     the block (HRA, or the General Fund). Kept raw: the headings and the
     numbers as typed, a blank as null. The tool reads a block exactly as it
     reads a paste of the same shape, so nothing here knows what a column
     means, and a workbook without the sheet reads as it always did. */
  function readProjections(wb, issues){
    /* Every sheet but the Benchmark, whose table is headed the same way and
       is worked FROM the projection, never typed. */
    const names = ["Projections"].concat((wb.order || []).filter(n => n !== "Projections" && n !== "Benchmark"));
    for(const name of names){
      const out = blocksOn(wb.sheets && wb.sheets[name], issues, name);
      if(out){
        if(name !== "Projections" && issues) issues.push(`The projection was read from the sheet "${name}": the Projections sheet was renamed. The tool finds its blocks by the "Year end" heading.`);
        return out;
      }
    }
    return null;
  }
  function blocksOn(cells, issues, sheetName){
    if(!cells) return null;
    const out = {}; let any = false;
    const at = (cc, rr) => cells.get(XL.colLetters(cc) + rr) || null;
    const blank = c => !c || c.v == null || String(c.v).trim() === "";
    for(const [addr, c] of cells){
      if(!c || c.kind !== "string" || norm(c.v) !== "year end") continue;
      const p = XL.ref(addr); if(!p) continue;
      const head = [];
      for(let cc = p.col; cc < p.col + 40; cc++){ const h = at(cc, p.row); if(blank(h)) break; head.push(String(h.v).trim()); }
      if(head.length < 2 || head.some(h => /net treasury position|liability benchmark/i.test(h))) continue;   /* a worked table, not a typed one */
      let title = "";
      for(let rr = p.row - 1; rr >= 1 && rr >= p.row - 6; rr--){ const t = at(p.col, rr); if(t && t.kind === "string" && String(t.v).trim()){ title = String(t.v).trim(); break; } }
      /* The HRA block by its own name: "General Fund (non-housing)" is not
         the HRA, and a test for "housing" alone read it as one (audit D27). */
      const fund = /\bhra\b|housing revenue/i.test(title) && !/general fund/i.test(title) ? "hra" : "gf";
      const rows = []; let text = 0, big = 0, thousands = 0;
      for(let rr = p.row + 1; rr <= p.row + 400; rr++){
        const y = at(p.col, rr); if(blank(y)) break;
        rows.push(head.map((_, j) => {
          if(j === 0) return String(y.v).trim();
          const v = at(p.col + j, rr); if(blank(v) || v.kind === "date") return null;
          const n = num(v); if(n == null){ text++; return null; }
          if(Math.abs(n) > 100000) big++;
          else if(Math.abs(n) >= 1000) thousands++;
          return n;
        }));
      }
      if(!rows.length || out[fund]) continue;
      out[fund] = {head, rows, title, at: addr}; any = true;
      if(issues){
        const block = `${sheetName || "Projections"} (${fund === "hra" ? "HRA" : "General Fund"})`;
        if(!head.some(h => /capital financing requirement/i.test(h))) issues.push(`${block}: no "Capital financing requirement" heading \u2014 the headings were changed; the tool matches columns by heading.`);
        if(text) issues.push(`${block}: ${text} cell${text === 1 ? " holds" : "s hold"} text where a figure should be; read as blank.`);
        if(big) issues.push(`${block}: ${big} figure${big === 1 ? "" : "s"} above 100,000 \u2014 this sheet is in \u00a3 millions; a figure that size is read as pounds and divided by a million.`);
        /* £ thousands typed by habit: 57,800 for a £57.8m CFR is read as
           £57,800m, with nothing to say so (audit D27). A figure of 1,000 or
           more in £m is possible for the largest authorities, so it is a
           question, not a change. */
        if(thousands) issues.push(`${block}: ${thousands} figure${thousands === 1 ? "" : "s"} of 1,000 or more \u2014 this sheet is in \u00a3 millions, so ${thousands === 1 ? "it is" : "they are"} read as \u00a31bn or more: check ${thousands === 1 ? "it is" : "they are"} not in \u00a3 thousands.`);
      }
    }
    return any ? out : null;
  }

  /* ---- the snapshot a report keeps ----------------------------------------
     The vocabulary words, the amounts and the dates (ISO), row by row,
     flagged rows included with their flags. Small, and the council's own.
     fromSnapshot brings it back as rows with the same derived fields, so a
     saved report draws its charts and sums exactly as the workbook did. */
  const iso = d => d ? d.toISOString().slice(0, 10) : null;
  const unIso = s => s ? new Date(s + "T00:00:00Z") : null;
  function snapshot(reg, name){
    const flags = r => r.issues.length ? {issues: r.issues.slice()} : {};
    return {
      v: 1, name: name || "", asAt: iso(reg.asAt), hra: reg.hra, version: reg.version, periodFrom: iso(reg.periodFrom), read: new Date().toISOString(),
      settingsIssues: reg.issues.slice(),
      /* the projection as read, headings and all: the tool fills its grid from it and locks the grid while the register is in use */
      projections: reg.projections ? JSON.parse(JSON.stringify(reg.projections)) : null,
      readiness: reg.readiness ? JSON.parse(JSON.stringify(reg.readiness)) : null,
      term: reg.termInvestments.map(r => Object.assign({row: r.row, type: r.type || r.typeRaw, counterparty: r.counterparty, cpType: r.cpType || r.cpTypeRaw,
        principal: r.principal, start: iso(r.start), maturity: iso(r.maturity), rate: r.rate, faceValue: r.faceValue, carryingValue: r.carryingValue, rating: r.rating}, flags(r))),
      call: reg.callAccounts.map(r => Object.assign({row: r.row, type: r.type || r.typeRaw, counterparty: r.counterparty, cpType: r.cpType || r.cpTypeRaw,
        balance: r.balance, rate: r.rate, noticeDays: r.noticeDays, rating: r.rating, avgBalance: r.avgBalance, avgRate: r.avgRate}, flags(r))),
      loans: reg.loans.map(r => Object.assign({row: r.row, type: r.type || r.typeRaw, lender: r.lender, lenderType: r.lenderType || r.lenderTypeRaw,
        principal: r.principal, start: iso(r.start), maturity: iso(r.maturity), rate: r.rate, profile: r.profile || r.profileRaw, frequency: r.frequency || r.frequencyRaw,
        firstRepayment: iso(r.firstRepayment), fund: r.fund || r.fundRaw, nextCall: iso(r.nextCall)}, flags(r))),
      funds: reg.pooledFunds.map(r => Object.assign({row: r.row, name: r.name, fundType: r.fundType || r.fundTypeRaw, carryingValue: r.carryingValue,
        latestValue: r.latestValue, rate: r.rate, purchased: iso(r.purchased), avgValue: r.avgValue, avgRate: r.avgRate}, flags(r)))
    };
  }
  function fromSnapshot(snap){
    const asAt = unIso(snap.asAt);
    const base = r => ({row: r.row, issues: (r.issues || []).slice()});
    const word = (list, v) => pick(list, v);
    const termInvestments = (snap.term || []).map(r => deriveTerm(Object.assign(base(r), {type: word(VOCAB.termTypes, r.type), typeRaw: r.type || "", counterparty: r.counterparty || "",
      cpType: word(VOCAB.counterpartyTypes, r.cpType), cpTypeRaw: r.cpType || "", principal: r.principal, start: unIso(r.start), maturity: unIso(r.maturity), rate: r.rate,
      faceValue: r.faceValue == null ? null : r.faceValue, carryingValue: r.carryingValue == null ? null : r.carryingValue, rating: r.rating || "", notes: ""}), asAt));
    const callAccounts = (snap.call || []).map(r => deriveCall(Object.assign(base(r), {type: word(VOCAB.callTypes, r.type), typeRaw: r.type || "", counterparty: r.counterparty || "",
      cpType: word(VOCAB.counterpartyTypes, r.cpType), cpTypeRaw: r.cpType || "", balance: r.balance, rate: r.rate, noticeDays: r.noticeDays == null ? null : r.noticeDays, rating: r.rating || "",
      avgBalance: r.avgBalance == null ? null : r.avgBalance, avgRate: r.avgRate == null ? null : r.avgRate, notes: ""})));
    const loans = (snap.loans || []).map(r => deriveLoan(Object.assign(base(r), {type: word(VOCAB.loanTypes, r.type), typeRaw: r.type || "", lender: r.lender || "",
      lenderType: word(VOCAB.lenderTypes, r.lenderType), lenderTypeRaw: r.lenderType || "", principal: r.principal, start: unIso(r.start), maturity: unIso(r.maturity), rate: r.rate,
      profile: word(VOCAB.profiles, r.profile) || (r.profile ? null : "Maturity"), profileRaw: r.profile || "", frequency: word(VOCAB.frequencies, r.frequency), frequencyRaw: r.frequency || "",
      firstRepayment: unIso(r.firstRepayment), fund: word(VOCAB.funds, r.fund), fundRaw: r.fund || "", nextCall: unIso(r.nextCall), notes: ""}), asAt));
    const pooledFunds = (snap.funds || []).map(r => deriveFund(Object.assign(base(r), {name: r.name || "", fundType: word(VOCAB.fundTypes, r.fundType), fundTypeRaw: r.fundType || "",
      carryingValue: r.carryingValue, latestValue: r.latestValue == null ? null : r.latestValue, rate: r.rate, purchased: unIso(r.purchased),
      avgValue: r.avgValue == null ? null : r.avgValue, avgRate: r.avgRate == null ? null : r.avgRate, notes: ""})));
    return {asAt, hra: snap.hra || null, hraRaw: snap.hra || "", twoPools: snap.hra === "Two pools", version: snap.version, periodFrom: unIso(snap.periodFrom), termInvestments, callAccounts, loans, pooledFunds,
      projections: snap.projections ? JSON.parse(JSON.stringify(snap.projections)) : null,
      readiness: snap.readiness ? JSON.parse(JSON.stringify(snap.readiness)) : null,
      issues: (snap.settingsIssues || []).slice(), read: snap.read ? new Date(snap.read) : new Date(), name: snap.name || "", fromSnapshot: true};
  }

  /* ---- loan repayment schedules ------------------------------------------
     [{date, amount}] of principal repaid after the as-at date. Maturity: all
     at the end — or at the next call date for a LOBO, the Code's assumption
     that the lender exercises its option. EIP: equal instalments at each
     payment date from the first repayment date, stepping by the frequency,
     ending on the maturity date. Annuity: level payments, so the principal
     part of each grows; the rate per period is the loan's rate over the
     periods in a year. */
  /* An anchor on the last day of its month (30 September) steps to month
     ends (31 March), the convention for half-yearly PWLB dates. */
  const addMonths = (d, n) => {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    const eom = new Date(Date.UTC(y, d.getUTCMonth() + 1, 0)).getUTCDate() === day;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, eom ? last : Math.min(day, last)));
  };
  /* THE CYCLE ENDS AT MATURITY. Stepping back from the maturity date by the
     frequency gives every payment date, and the first of them after the
     start is the first repayment: a stub period at the front, which is how
     PWLB loans run (Phil, 3 October 2026: "we can leave first repayment
     date empty and it assumes the first coupon date after the start date
     (PWLB loans always have a front end stub)"). A First repayment date
     given is used as given. A loan with no start date and no first date
     pays on the maturity cycle from the as-at date onwards (every cycle
     date, which the forward filter then trims). */
  function firstPaymentDate(loan){
    if(loan.firstRepayment) return loan.firstRepayment;
    if(!loan.maturity) return null;
    const step = 12 / (PER_YEAR[loan.frequency] || 2), from = loan.start || null;
    let k = 1, d = addMonths(loan.maturity, -step);
    if(!from){ while(k < 2000 && d > new Date(Date.UTC(1990, 0, 1))){ k++; d = addMonths(loan.maturity, -step * k); } return addMonths(loan.maturity, -step * (k - 1)); }
    while(k < 2000 && d > from){ k++; d = addMonths(loan.maturity, -step * k); }
    return addMonths(loan.maturity, -step * (k - 1));
  }
  function paymentDates(loan){
    const step = 12 / (PER_YEAR[loan.frequency] || 1), out = [], first = firstPaymentDate(loan);
    if(!first) return [loan.maturity];
    for(let k = 0, d = first; d < loan.maturity && k < 2000; k++, d = addMonths(first, step * k)) out.push(d);
    out.push(loan.maturity);
    return out;
  }
  function schedule(loan, asAt){
    const end = loanEnd(loan, asAt);
    if(loan.profile === "Maturity" || !loan.profile) return [{date: end, amount: loan.principal}];
    const dates = paymentDates(loan).filter(d => d > asAt);
    if(!dates.length) return [{date: loan.maturity, amount: loan.principal}];
    if(loan.profile === "EIP"){
      const each = loan.principal / dates.length;
      return dates.map(d => ({date: d, amount: each}));
    }
    /* annuity */
    const r = (loan.rate || 0) / (PER_YEAR[loan.frequency] || 1), n = dates.length;
    if(!(r > 0)) return dates.map(d => ({date: d, amount: loan.principal / n}));
    const pay = loan.principal * r / (1 - Math.pow(1 + r, -n));
    let bal = loan.principal; const out = [];
    dates.forEach((d, i) => { const p = i === n - 1 ? bal : pay - bal * r; out.push({date: d, amount: p}); bal -= p; });
    return out;
  }

  /* ---- the sums --------------------------------------------------------- */
  const BUCKETS = ["Under 3 months", "3 to 6 months", "6 to 12 months", "1 to 2 years", "2 to 5 years", "Over 5 years"];
  /* The Code's maturity structure of borrowing. */
  const DEBT_BUCKETS = ["Under 12 months", "12 to 24 months", "2 to 5 years", "5 to 10 years", "10 to 20 years", "20 to 30 years", "30 to 40 years", "40 to 50 years", "Over 50 years"];
  /* WHOLE MONTHS, AS THE MARKET AND THE WORKBOOK COUNT THEM (audit A14, B4,
     D10, E21, 5 October 2026): the most months m for which addMonths(a, m)
     is on or before b, where a month end steps to month ends. So 31 March
     to 30 June is three months, not two, and 31 March to 30 September is
     six; the workbook's bucket edges and payment dates step the same way
     (EOMONTH from a month end, EDATE otherwise). */
  const monthsBetween = (a, b) => { let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()); if(addMonths(a, m) > b) m--; return m; };
  function bucketOf(asAt, maturity){
    const m = monthsBetween(asAt, maturity);
    if(m < 3) return 0; if(m < 6) return 1; if(m < 12) return 2; if(m < 24) return 3; if(m < 60) return 4; return 5;
  }
  function debtBucketOf(asAt, d){
    const m = monthsBetween(asAt, d);
    if(m < 12) return 0; if(m < 24) return 1; if(m < 60) return 2; if(m < 120) return 3; if(m < 240) return 4; if(m < 360) return 5; if(m < 480) return 6; if(m < 600) return 7; return 8;
  }
  function ladder(reg){
    const sums = BUCKETS.map(b => ({label: b, total: 0, count: 0}));
    if(!reg.asAt) return sums;
    reg.termInvestments.filter(r => r.counts).forEach(r => { const i = bucketOf(reg.asAt, r.maturity); sums[i].total += r.nominal; sums[i].count++; });
    return sums;
  }
  /* Nominal still out at each 31 March after the as-at date: what the
     report's "existing investment commitments" column is made of. */
  const firstYearEnd = asAt => { let y = asAt.getUTCFullYear(); if(asAt.getUTCMonth() > 2 || (asAt.getUTCMonth() === 2 && asAt.getUTCDate() >= 31)) y++; return y; };
  function yearEnds(reg, n){
    const out = [];
    if(!reg.asAt) return out;
    const y = firstYearEnd(reg.asAt);
    for(let k = 0; k < (n || 5); k++){
      const ye = new Date(Date.UTC(y + k, 2, 31));
      const rows = reg.termInvestments.filter(r => r.runsOff && r.maturity > ye && !(r.start && r.start > ye));   /* a forward deal from its start */
      out.push({label: `31 Mar ${y + k}`, fy: `${y + k - 1}/${String(y + k).slice(2)}`, date: ye, total: rows.reduce((s, r) => s + r.nominal, 0), count: rows.length});
    }
    return out;
  }
  function debtLadder(reg){
    const sums = DEBT_BUCKETS.map(b => ({label: b, total: 0, count: 0}));
    if(!reg.asAt) return sums;
    reg.loans.filter(l => l.counts).forEach(l => {
      const seen = new Set();
      l.schedule.forEach(p => { const i = debtBucketOf(reg.asAt, p.date); sums[i].total += p.amount; if(!seen.has(i)){ seen.add(i); sums[i].count++; } });
    });
    return sums;
  }
  /* What a loan still owes at a date after the as-at date: its principal
     less what its schedule repays on or before it, and nothing before a
     forward loan starts (it runs off from its start: audit A3). */
  const outstandingAt = (l, d) => l.start && l.start > d ? 0 : l.principal - l.schedule.filter(p => p.date <= d).reduce((s, p) => s + p.amount, 0);
  /* Debt still outstanding at each 31 March: the loans less what their
     schedules repay on or before that day. */
  function debtYearEnds(reg, n){
    const out = [];
    if(!reg.asAt) return out;
    const y = firstYearEnd(reg.asAt), loans = reg.loans.filter(l => l.runsOff);
    for(let k = 0; k < (n || 10); k++){
      const ye = new Date(Date.UTC(y + k, 2, 31));
      let total = 0, count = 0;
      loans.forEach(l => { const left = outstandingAt(l, ye); if(left > 0.5){ total += left; count++; } });
      out.push({label: `31 Mar ${y + k}`, fy: `${y + k - 1}/${String(y + k).slice(2)}`, date: ye, total, count});
    }
    return out;
  }
  /* ---- the shapes the charts draw ----------------------------------------
     Each gives rows of {label, parts:{key: amount}, total, count}: a stacked
     bar per label, one segment per key. */
  const catRows = labels => labels.map(l => ({label: l, parts: {}, total: 0, count: 0}));
  const addPart = (row, k, v) => { row.parts[k] = (row.parts[k] || 0) + v; row.total += v; row.count++; };
  const noticeDate = (asAt, days) => new Date(asAt.getTime() + days * 86400000);
  /* The investment ladder by counterparty type, money on call first; a
     notice account sits at its notice. */
  function ladderBy(reg){
    const out = catRows(["On call"].concat(BUCKETS));
    if(!reg.asAt) return out;
    reg.termInvestments.filter(r => r.counts).forEach(r => addPart(out[1 + bucketOf(reg.asAt, r.maturity)], r.cpType || "Not on the list", r.nominal));
    reg.callAccounts.filter(r => r.counts).forEach(r => addPart(out[r.noticeDays > 0 ? 1 + bucketOf(reg.asAt, noticeDate(reg.asAt, r.noticeDays)) : 0], r.cpType || "Not on the list", r.balance));
    return out;
  }
  /* The Code's maturity structure by lender type, from the schedules. */
  function debtLadderBy(reg){
    const out = catRows(DEBT_BUCKETS);
    if(!reg.asAt) return out;
    reg.loans.filter(l => l.counts).forEach(l => {
      const seen = new Set();
      l.schedule.forEach(p => { const i = debtBucketOf(reg.asAt, p.date), row = out[i], k = l.lenderType || "Not on the list";
        row.parts[k] = (row.parts[k] || 0) + p.amount; row.total += p.amount; if(!seen.has(i)){ seen.add(i); row.count++; } });
    });
    return out;
  }
  /* Debt outstanding at each 31 March, split by fund (two pools) or by lender
     type, for n year ends or until the last repayment, whichever is sooner;
     all n when full (the chart's fifty-year horizon, 3 October 2026). */
  function runoffBy(reg, n, key, full){
    const out = [];
    if(!reg.asAt) return out;
    const loans = reg.loans.filter(l => l.runsOff), y = firstYearEnd(reg.asAt);
    const last = loans.reduce((m, l) => Math.max(m, ...l.schedule.map(p => p.date.getUTCFullYear())), y);
    const N = full ? (n || 50) : Math.min(n || 50, Math.max(1, last - y + 1));
    for(let k = 0; k < N; k++){
      const ye = new Date(Date.UTC(y + k, 2, 31)), row = {label: `31 Mar ${y + k}`, parts: {}, total: 0, count: 0};
      loans.forEach(l => { const left = outstandingAt(l, ye);
        if(left > 0.5){ const kk = key === "fund" ? (l.fund || "Unassigned") : (l.lenderType || "Not on the list"); row.parts[kk] = (row.parts[kk] || 0) + left; row.total += left; row.count++; } });
      out.push(row);
    }
    return out;
  }
  /* What is still out, month by month: term deals at nominal still placed at
     the as-at date and at each month end after it, to the last maturity, by
     counterparty type. The form a large book takes where a timeline would be
     a line per deal (Phil, 3 October 2026: "some clients have 100s of deals"). */
  function invRunoff(reg, months){
    const out = [];
    if(!reg.asAt) return out;
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const term = reg.termInvestments.filter(r => r.counts && r.maturity);
    const last = term.reduce((m, r) => Math.max(m, r.maturity.getTime()), reg.asAt.getTime()), lastD = new Date(last);
    const y0 = reg.asAt.getUTCFullYear(), m0 = reg.asAt.getUTCMonth();
    /* The as-at date, then every month end after it: an as-at date in the
       middle of a month is followed by that month's end, not the next one's,
       and is labelled by its day (audit D26, 5 October 2026). */
    const eom = isMonthEnd(reg.asAt), k0 = eom ? 1 : 0;
    const N = Math.min(months || 120, Math.max(1, (lastD.getUTCFullYear() - y0) * 12 + (lastD.getUTCMonth() - m0) + 1 + (eom ? 0 : 1)));
    for(let k = 0; k < N; k++){
      const at = k === 0 ? reg.asAt : new Date(Date.UTC(y0, m0 + k - 1 + k0 + 1, 0));
      const row = {label: (k === 0 && !eom ? at.getUTCDate() + " " : "") + MON[at.getUTCMonth()] + " " + String(at.getUTCFullYear()).slice(2), at, parts: {}, total: 0, count: 0};
      term.forEach(r => { if(r.maturity > at){ const kk = r.cpType || "Not on the list"; row.parts[kk] = (row.parts[kk] || 0) + r.nominal; row.total += r.nominal; row.count++; } });
      out.push(row);
    }
    return out;
  }
  /* Investments maturing in and loan repayments out, a month at a time from
     the day after the as-at date: month k runs from the day after
     addMonths(asAt, k − 1) to addMonths(asAt, k), so twelve of them are
     exactly the next twelve months (audit A16, B3, D26, 5 October 2026).
     At a month end they are the calendar months after it, labelled "Oct 26";
     in the middle of a month nothing due in the rest of that month is lost,
     and each is labelled by its last day, "to 15 Jan 27". The workbook's
     Dashboard counts the same periods. */
  const isMonthEnd = d => new Date(d.getTime() + 86400000).getUTCDate() === 1;
  function calendar(reg, months){
    const out = [];
    if(!reg.asAt) return out;
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], eom = isMonthEnd(reg.asAt);
    for(let k = 1; k <= (months || 24); k++){
      const from = addMonths(reg.asAt, k - 1), to = addMonths(reg.asAt, k);
      const lab = (eom ? "" : "to " + to.getUTCDate() + " ") + MON[to.getUTCMonth()] + " " + String(to.getUTCFullYear()).slice(2);
      out.push({ym: to.getUTCFullYear() * 12 + to.getUTCMonth(), from, to, label: lab, year: to.getUTCFullYear(), month: to.getUTCMonth(), inflow: 0, outflow: 0, inDeals: [], outLoans: [], outAmounts: new Map()});
    }
    const slot = d => out.find(m => d > m.from && d <= m.to);
    reg.termInvestments.filter(r => r.counts).forEach(r => { const m = slot(r.maturity); if(m){ m.inflow += r.nominal; m.inDeals.push(r); } });
    reg.loans.filter(l => l.counts).forEach(l => l.schedule.forEach(p => { const m = slot(p.date); if(m){ m.outflow += p.amount; if(m.outLoans.indexOf(l) < 0) m.outLoans.push(l); m.outAmounts.set(l, (m.outAmounts.get(l) || 0) + p.amount); } }));
    return out;
  }
  /* Exposure by counterparty: term deals at nominal and call balances. */
  /* Local authorities are one counterparty in every output (Phil, 3 October
     2026: "LA positions should be grouped - they're effectively homogenous"):
     the credit is the same whichever council holds the money, so the
     exposure is the sum, with how many authorities it is across. */
  const LA = "Local authority", LA_GROUP = "Local authorities";
  function exposure(reg){
    const by = {};
    const add = (r, v) => { const la = r.cpType === LA, k = la ? "\u0000la" : norm(r.counterparty);
      const o = by[k] || (by[k] = {counterparty: la ? LA_GROUP : r.counterparty, cpType: r.cpType || "Not on the list", total: 0, deals: 0, names: {}});
      o.total += v; o.deals++; o.names[norm(r.counterparty)] = 1; };
    reg.termInvestments.filter(r => r.counts).forEach(r => add(r, r.nominal));
    reg.callAccounts.filter(r => r.counts).forEach(r => add(r, r.balance));
    return Object.values(by).map(o => ({counterparty: o.counterparty, cpType: o.cpType, total: o.total, deals: o.deals, names: Object.keys(o.names).length})).sort((a, b) => b.total - a.total);
  }
  /* Every investment as a point: months to maturity (nil for money on call)
     against its rate, sized by amount. */
  function yieldPoints(reg){
    if(!reg.asAt) return [];
    const pts = reg.termInvestments.filter(r => r.counts && r.rate != null).map(r => ({name: r.counterparty, type: r.type, cpType: r.cpType || "Not on the list",
      months: Math.max(0, (r.maturity - reg.asAt) / 86400000 / 30.436875), rate: r.rate, amount: r.nominal, maturity: r.maturity}));
    reg.callAccounts.filter(r => r.counts && r.rate != null).forEach(r => pts.push({name: r.counterparty, type: r.type, cpType: r.cpType || "Not on the list",
      months: r.noticeDays > 0 ? r.noticeDays / 30.436875 : 0, rate: r.rate, amount: r.balance, maturity: null}));
    return pts;
  }
  /* Every loan as a point: years to final maturity against its rate, sized by
     the principal outstanding. */
  function costPoints(reg){
    if(!reg.asAt) return [];
    return reg.loans.filter(l => l.counts && l.rate != null).map(l => ({name: l.lender, type: l.type, lenderType: l.lenderType || "Not on the list", fund: l.fund,
      years: Math.max(0, years(reg.asAt, l.maturity)), rate: l.rate, amount: l.principal, maturity: l.maturity, nextCall: l.nextCall, profile: l.profile}));
  }

  /* ---- activity: what was placed, matured, raised and repaid in a period ----
     A term deal is placed on its start date and matures on its maturity date;
     a loan is raised on its start date and repaid at maturity (a LOBO at its
     call), or instalment by instalment for an EIP or annuity, the past
     instalments reconstructed backward from what is outstanding now. Only
     dates on or before the as-at date are history; the future is projection. */
  const fyStart = d => new Date(Date.UTC(d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1, 3, 1));
  /* The period on Settings: from the date given, or 1 April, to the as-at
     date. The averages on the call account and pooled fund sheets cover it. */
  const settingsPeriod = reg => reg.asAt ? {from: reg.periodFrom || fyStart(reg.asAt), to: reg.asAt} : null;
  function periods(reg){
    if(!reg.asAt) return [];
    const a = reg.asAt, f0 = fyStart(a), y = f0.getUTCFullYear(), fy = y => `${y}/${String(y + 1).slice(2)}`;
    const m12 = new Date(addMonths(a, -12).getTime() + 86400000);
    const sp = settingsPeriod(reg), own = reg.periodFrom && reg.periodFrom.getTime() !== f0.getTime();
    return [
      own ? {key: "fytd", label: `${dmy(sp.from)} to ${dmy(a)}, the period on Settings`, from: sp.from, to: a, settings: true}
          : {key: "fytd", label: `${fy(y)} to ${dmy(a)}`, from: f0, to: a, settings: true},
      {key: "prev", label: fy(y - 1), from: new Date(Date.UTC(y - 1, 3, 1)), to: new Date(Date.UTC(y, 2, 31))},
      {key: "12m", label: `the 12 months to ${dmy(a)}`, from: m12, to: a}
    ];
  }
  function pastSchedule(loan, asAt){
    if(!loan.profile || loan.profile === "Maturity" || !loan.frequency || !loan.maturity || !firstPaymentDate(loan)) return [];
    const all = paymentDates(loan), past = all.filter(d => d <= asAt), future = all.filter(d => d > asAt).length;
    if(!past.length || !future) return [];
    if(loan.profile === "EIP"){ const each = loan.principal / future; return past.map(d => ({date: d, amount: each})); }
    const r = (loan.rate || 0) / (PER_YEAR[loan.frequency] || 1);
    if(!(r > 0)) return past.map(d => ({date: d, amount: loan.principal / future}));
    const pay = loan.principal * r / (1 - Math.pow(1 + r, -future));
    let bal = loan.principal; const out = [];
    for(let i = past.length - 1; i >= 0; i--){ const before = (bal + pay) / (1 + r); out.unshift({date: past[i], amount: before - bal}); bal = before; }
    return out;
  }
  /* Where a loan ends: a LOBO at its next call when the call is after the
     as-at date and before the maturity, every other loan at its maturity
     (the rule in readRegister's Loans, and the workbook's). */
  const loanEnd = (l, asAt) => l.type === "LOBO" && l.nextCall && (!asAt || l.nextCall > asAt) && l.nextCall < l.maturity ? l.nextCall : l.maturity;
  /* A weighted average over the rows that have the value: a row with no rate
     is left out of the weights rather than averaged in at nought (audit D23). */
  const wavgOf = (rows, amt, val) => { const has = rows.filter(r => val(r) != null), t = has.reduce((s, r) => s + amt(r), 0); return t ? has.reduce((s, r) => s + amt(r) * val(r), 0) / t : null; };
  const isAmortising = l => l.profile === "EIP" || l.profile === "Annuity";
  function activity(reg, from, to){
    const inP = d => !!d && d >= from && d <= to;
    const term = reg.termInvestments.filter(r => r.nominal > 0 && r.start && r.maturity);
    const placed = term.filter(r => inP(r.start)), matured = term.filter(r => r.history && inP(r.maturity));
    const loans = reg.loans.filter(l => l.principal > 0 && l.maturity);
    /* RAISED IS WHAT WAS BORROWED (audit A2, D3, 5 October 2026): an EIP or
       annuity loan raised in the period and already repaying is raised at
       its principal then, not at what is left now, or the instalments it has
       paid are in Repaid and missing from Raised and the two do not
       reconcile to the change in debt. */
    const raised = loans.filter(l => inP(l.start));
    const repaid = [];
    loans.forEach(l => {
      if(!isAmortising(l)){ const end = loanEnd(l, reg.asAt); if(reg.asAt && end <= reg.asAt && inP(end)) repaid.push({loan: l, date: end, amount: l.principal}); }
      /* An EIP or annuity loan that has ended is history, its Principal what
         was left to repay: repaid at its maturity, as the workbook counts it
         (audit A9, D4); before, it was left out, having no dates to come. */
      else if(reg.asAt && l.maturity <= reg.asAt){ if(inP(l.maturity)) repaid.push({loan: l, date: l.maturity, amount: l.principal}); }
      else if(reg.asAt) pastSchedule(l, reg.asAt).forEach(p => { if(inP(p.date)) repaid.push({loan: l, date: p.date, amount: p.amount}); });
    });
    const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
    const amt = l => l.raised != null ? l.raised : l.principal;
    /* The average term placed in months of days (30.4375 days, a year over
       twelve), not whole months floored: a 90-day bill is three months, not
       two (audit D22). A deal dated backwards has no term to average (D24). */
    const termed = placed.filter(r => r.maturity > r.start);
    return {from, to,
      placed:  {rows: placed,  total: sum(placed, r => r.nominal),  count: placed.length,  rate: wavgOf(placed, r => r.nominal, r => r.rate), months: wavgOf(termed, r => r.nominal, r => (r.maturity - r.start) / 86400000 / 30.4375)},
      matured: {rows: matured, total: sum(matured, r => r.nominal), count: matured.length, rate: wavgOf(matured, r => r.nominal, r => r.rate)},
      raised:  {rows: raised,  total: sum(raised, amt), count: raised.length, rate: wavgOf(raised, amt, l => l.rate), years: wavgOf(raised, amt, l => l.start ? years(l.start, l.maturity) : 0)},
      repaid:  {rows: repaid,  total: sum(repaid, p => p.amount), count: new Set(repaid.map(p => p.loan)).size, rate: wavgOf(repaid, p => p.amount, p => p.loan.rate)}};
  }
  /* Month by month across the period: placed and matured, raised and repaid. */
  function activityByMonth(reg, from, to){
    const out = [], MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for(let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
      out.push({ym: d.getUTCFullYear() * 12 + d.getUTCMonth(), label: MON[d.getUTCMonth()] + " " + String(d.getUTCFullYear()).slice(2), placed: 0, matured: 0, raised: 0, repaid: 0, placedRows: [], maturedRows: [], raisedRows: [], repaidRows: []});
    const slot = d => out.find(m => m.ym === d.getUTCFullYear() * 12 + d.getUTCMonth());
    const A = activity(reg, from, to);
    A.placed.rows.forEach(r => { const m = slot(r.start); if(m){ m.placed += r.nominal; m.placedRows.push(r); } });
    A.matured.rows.forEach(r => { const m = slot(r.maturity); if(m){ m.matured += r.nominal; m.maturedRows.push(r); } });
    A.raised.rows.forEach(l => { const m = slot(l.start); if(m){ m.raised += l.raised != null ? l.raised : l.principal; m.raisedRows.push(l); } });
    A.repaid.rows.forEach(p => { const m = slot(p.date); if(m){ m.repaid += p.amount; m.repaidRows.push(p); } });
    return out;
  }
  /* Where the money placed (or raised) in the period went, by the term at
     placement, in segments by counterparty (or lender) type. */
  const TERM_BUCKETS = ["Under 1 month", "1 to 3 months", "3 to 6 months", "6 to 12 months", "1 to 2 years", "2 to 5 years", "Over 5 years"];
  const termBucketOf = m => m < 1 ? 0 : m < 3 ? 1 : m < 6 ? 2 : m < 12 ? 3 : m < 24 ? 4 : m < 60 ? 5 : 6;
  function termAllocation(reg, from, to, kind){
    const out = catRows(TERM_BUCKETS), A = activity(reg, from, to);
    if(kind === "raised") A.raised.rows.forEach(l => { if(l.start && l.maturity > l.start) addPart(out[termBucketOf(monthsBetween(l.start, l.maturity))], l.lenderType || "Not on the list", l.raised != null ? l.raised : l.principal); });
    else A.placed.rows.forEach(r => { if(r.maturity > r.start) addPart(out[termBucketOf(monthsBetween(r.start, r.maturity))], r.cpType || "Not on the list", r.nominal); });   /* a deal dated backwards has no term: flagged, not allocated (audit D24) */
    return out;
  }

  /* ---- indicative interest, on deal terms ----------------------------------
     Simple interest, actual days over 365, on the principal of each term deal
     and the balance of each loan, between two dates. A deal's own terms and
     nothing else: no accruals, no effective-interest adjustment — a figure to
     set against the ledger, never the ledger. A loan's balance between two
     dates follows its schedule, backward from the as-at date and forward, so
     an instalment paid mid-period counts for the days it was outstanding. */
  const DAY = 86400000;
  const overlapDays = (a0, a1, b0, b1) => Math.max(0, (Math.min(a1, b1) - Math.max(a0, b0)) / DAY);
  /* [{from, to, balance}] for a loan across [from, to], by its schedule. */
  function loanBalances(loan, asAt, from, to){
    const past = pastSchedule(loan, asAt), future = loan.schedule || [];
    const end = loanEnd(loan, asAt), start = loan.start || from;
    const lo = new Date(Math.max(from, start)), hi = new Date(Math.min(to, end));
    if(!(hi > lo)) return [];
    const points = [...past, ...future].map(p => p.date).filter(d => d > lo && d < hi).sort((a, b) => a - b);
    const edges = [lo, ...points, hi], out = [];
    for(let i = 0; i < edges.length - 1; i++){
      const mid = new Date((edges[i].getTime() + edges[i + 1].getTime()) / 2);
      const bal = loan.principal + past.filter(p => p.date > mid).reduce((t, p) => t + p.amount, 0) - future.filter(p => p.date <= mid).reduce((t, p) => t + p.amount, 0);
      out.push({from: edges[i], to: edges[i + 1], balance: Math.max(0, bal)});
    }
    return out;
  }
  /* THE PERIOD IS EVERY DAY FROM `from` TO `to`, BOTH INCLUDED (audit D2, E19,
     5 October 2026). A deal earns, and a loan costs, a night's interest for
     each day it is held at the day's end: from its start, up to the day
     before it matures. The window used to stop at the start of `to`, so 1
     April to 30 September left out the 30 September night and the year to
     31 March was 364 days. Term deals and loans now count every day; the
     income on money on call, in MMFs and in pooled funds is the stated
     average balance at the stated average rate and is worked as it always
     was, over the days from `from` to `to` (Phil: nothing on the
     performance of MMF and call). */
  function interestIn(reg, from, to){
    const to1 = new Date(to.getTime() + DAY);
    const earnedRows = reg.termInvestments.filter(r => r.principal > 0 && r.start && r.maturity && r.rate != null)
      .map(r => ({row: r, days: overlapDays(r.start, r.maturity, from, to1)})).filter(x => x.days > 0)
      .map(x => ({name: x.row.counterparty, type: x.row.type, days: x.days, amount: x.row.principal * x.row.rate * x.days / 365}));
    /* A loan with no rate stays in the average debt, though it adds no
       interest (audit D23): it was owed all the same. */
    const payableRows = reg.loans.filter(l => l.principal > 0 && l.maturity)
      .map(l => { const segs = loanBalances(l, reg.asAt, from, to1); const days = segs.reduce((t, g) => t + (g.to - g.from) / DAY, 0);
        return {name: l.lender, type: l.type, days, rated: l.rate != null, amount: l.rate == null ? 0 : segs.reduce((t, g) => t + g.balance * l.rate * (g.to - g.from) / DAY / 365, 0), balDays: segs.reduce((t, g) => t + g.balance * (g.to - g.from) / DAY, 0)}; })
      .filter(x => x.days > 0);
    const days = Math.max(1, (to1 - from) / DAY), span = Math.max(1, (to - from) / DAY);
    /* Money on call, in MMFs and in pooled funds: income from the average
       balance and the average rate stated for the period on Settings, and
       only for that period — any other window has no figures to read. */
    const sp = settingsPeriod(reg), stated = !!(sp && sp.from.getTime() === from.getTime() && sp.to.getTime() === to.getTime());
    const callRows = stated ? reg.callAccounts.filter(r => r.avgBalance > 0 && r.avgRate != null).map(r => ({name: r.counterparty, type: r.type, days: span, amount: r.avgBalance * r.avgRate * span / 365, avg: r.avgBalance})) : [];
    const fundRows = stated ? reg.pooledFunds.filter(r => r.avgValue > 0 && r.avgRate != null).map(r => ({name: r.name, type: r.fundType, days: span, amount: r.avgValue * r.avgRate * span / 365, avg: r.avgValue})) : [];
    const avgTerm = reg.termInvestments.filter(r => r.principal > 0 && r.start && r.maturity).reduce((t, r) => t + r.principal * overlapDays(r.start, r.maturity, from, to1), 0) / days;
    const unstated = stated ? reg.callAccounts.filter(r => r.counts && !(r.avgBalance > 0 && r.avgRate != null)).length + reg.pooledFunds.filter(r => r.counts && !(r.avgValue > 0 && r.avgRate != null)).length
                            : reg.callAccounts.filter(r => r.counts).length + reg.pooledFunds.filter(r => r.counts).length;
    /* The rate of return, annualised: each part over its own days — term
       deals over every day of the period, the stated income on call and in
       funds over the days it was always worked on — so the call and fund
       part of the return is what it always was (Phil: nothing on the
       performance of MMF and call). */
    const earnedT = earnedRows.reduce((t, x) => t + x.amount, 0), statedInc = callRows.reduce((t, x) => t + x.amount, 0) + fundRows.reduce((t, x) => t + x.amount, 0);
    const avgInv = avgTerm + callRows.reduce((t, x) => t + x.avg, 0) + fundRows.reduce((t, x) => t + x.avg, 0);
    return {from, to, stated, days, ret: avgInv ? (earnedT * 365 / days + statedInc * 365 / span) / avgInv : null,
      earned: {total: earnedRows.reduce((t, x) => t + x.amount, 0), count: earnedRows.length, rows: earnedRows},
      earnedCall: {total: callRows.reduce((t, x) => t + x.amount, 0), count: callRows.length, rows: callRows},
      earnedFunds: {total: fundRows.reduce((t, x) => t + x.amount, 0), count: fundRows.length, rows: fundRows},
      unstated,
      income: earnedRows.reduce((t, x) => t + x.amount, 0) + callRows.reduce((t, x) => t + x.amount, 0) + fundRows.reduce((t, x) => t + x.amount, 0),
      avgInvestments: avgTerm + callRows.reduce((t, x) => t + x.avg, 0) + fundRows.reduce((t, x) => t + x.avg, 0), avgTerm,
      payable: {total: payableRows.reduce((t, x) => t + x.amount, 0), count: payableRows.filter(x => x.rated).length, rows: payableRows},
      avgDebt: payableRows.reduce((t, x) => t + x.balDays, 0) / days};
  }
  /* To the year end from the as-at date, on what is already placed and
     already borrowed: committed, not forecast. */
  /* The 31 March that closes the as-at date's own year; none when the as-at
     date is that 31 March. firstYearEnd steps to the NEXT one, so a register
     dated at its year end (an outturn) added a whole further year of interest
     "more to 31 March" (review of 4 October 2026). */
  /* From the day after the as-at date to 31 March, both included: with the
     year to date, every day of the year once (audit D2). */
  function interestToYearEnd(reg){
    if(!reg.asAt) return null;
    const a = reg.asAt, ye = new Date(Date.UTC(a.getUTCMonth() >= 3 ? a.getUTCFullYear() + 1 : a.getUTCFullYear(), 2, 31));
    return ye > a ? interestIn(reg, new Date(a.getTime() + DAY), ye) : null;
  }

  const byKey = (rows, key, amount) => { const o = {}; rows.forEach(r => { const k = r[key] || "Not on the list"; o[k] = (o[k] || 0) + amount(r); }); return o; };
  /* Each month end after `from`, then `to` itself, which closes the list
     whether or not it is a month end. */
  function monthEnds(from, to){
    const out = []; const y = from.getUTCFullYear(), m = from.getUTCMonth();
    for(let k = 0; k < 600; k++){ const e = new Date(Date.UTC(y, m + k + 1, 0)); if(e >= to) break; if(e > from) out.push(e); }
    out.push(to); return out;
  }
  function stats(reg){
    const term = reg.termInvestments.filter(r => r.counts), call = reg.callAccounts.filter(r => r.counts), funds = reg.pooledFunds.filter(r => r.counts);
    const nominal = term.reduce((s, r) => s + r.nominal, 0), callTotal = call.reduce((s, r) => s + r.balance, 0), fundsTotal = funds.reduce((s, r) => s + r.carryingValue, 0);
    const invested = nominal + callTotal;   /* treasury investments at nominal; pooled funds shown apart, at carrying value */
    /* Rates weighted over the rows that state one (audit D23): a blank rate
       is flagged on its row, and averaged in at nought it dragged the rate
       down. The workbook weights the same rows. */
    const rated = term.filter(r => r.rate != null).map(r => [r.nominal, r.rate]).concat(call.filter(r => r.rate != null).map(r => [r.balance, r.rate]));
    const ratedTotal = rated.reduce((s, x) => s + x[0], 0);
    const invRate = ratedTotal ? rated.reduce((s, x) => s + x[0] * x[1], 0) / ratedTotal : null;
    const wLife = nominal && reg.asAt ? term.reduce((s, r) => s + r.nominal * years(reg.asAt, r.maturity), 0) / nominal : null;
    const byType = byKey(term, "cpType", r => r.nominal); call.forEach(r => { const k = r.cpType || "Not on the list"; byType[k] = (byType[k] || 0) + r.balance; });
    const cps = new Set([...term.map(r => norm(r.counterparty)), ...call.map(r => norm(r.counterparty))]).size;

    const loans = reg.loans.filter(l => l.counts);
    const debt = loans.reduce((s, l) => s + l.principal, 0);
    const debtRate = wavgOf(loans, l => l.principal, l => l.rate);
    const debtLife = debt && reg.asAt ? loans.reduce((s, l) => s + l.schedule.reduce((t, p) => t + p.amount * years(reg.asAt, p.date), 0), 0) / debt : null;
    const byLender = byKey(loans, "lenderType", l => l.principal);
    const byFund = reg.twoPools ? byKey(loans, "fund", l => l.principal) : null;
    const lobos = loans.filter(l => l.type === "LOBO");
    const flagged = [reg.termInvestments, reg.callAccounts, reg.loans, reg.pooledFunds].reduce((s, t) => s + t.filter(r => r.issues.length).length, 0);
    const matured = reg.termInvestments.filter(r => r.history).length, repaid = reg.loans.filter(l => l.history).length;
    return {
      invested, nominal, callTotal, fundsTotal, fundsLatest: funds.reduce((s, r) => s + (r.latestValue == null ? r.carryingValue : r.latestValue), 0),
      termPrincipal: term.reduce((s, r) => s + r.principal, 0),
      deals: term.length + call.length, termDeals: term.length, callDeals: call.length, funds: funds.length, counterparties: cps,
      invRate, wLife, byType,
      debt, loans: loans.length, debtRate, debtLife, byLender, byFund, lobos: lobos.length, loboTotal: lobos.reduce((s, l) => s + l.principal, 0),
      net: invested + fundsTotal - debt, flagged, matured, repaid
    };
  }
  return {TEMPLATE_VERSION, VOCAB, BUCKETS, DEBT_BUCKETS, readRegister, readProjections, readReadiness, schedule, ladder, yearEnds, debtLadder, debtYearEnds, stats, dmy, money, pct, bucketOf, debtBucketOf, addMonths, monthsBetween, isMonthEnd, loanEnd, outstandingAt, wavgOf, rate,
    ladderBy, debtLadderBy, runoffBy, calendar, exposure, yieldPoints, costPoints, snapshot, fromSnapshot,
    TERM_BUCKETS, periods, settingsPeriod, LA_GROUP, invRunoff, pastSchedule, firstPaymentDate, paymentDates, activity, activityByMonth, termAllocation, interestIn, interestToYearEnd, loanBalances, monthEnds};
})();

export default REG;
