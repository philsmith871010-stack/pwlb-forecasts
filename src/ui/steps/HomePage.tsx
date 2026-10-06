import { useStore } from '../../state/store';
import { APP_NAME_PARTS } from '../../config';
import { ago } from '../../lib/format';

const STAGES = [
  { icon: 'bi-cloud-arrow-up', title: 'Load', text: 'Open your team file and drop in three to five years of bank statement exports (CSV). Any bank, several accounts — they’re merged.' },
  { icon: 'bi-tags', title: 'Sort', text: 'Every line is sorted automatically — council tax, payroll, suppliers, grants — and loans and investments are picked out and set aside.' },
  { icon: 'bi-ui-checks', title: 'Confirm', text: 'A short review of anything uncertain, biggest money first. Each confirmation becomes a rule, so next time is quicker.' },
  { icon: 'bi-bar-chart-line', title: 'Look back', text: 'See how your cash really behaves: yearly trends, seasonal dips, payday patterns, what changed and why.' },
  { icon: 'bi-graph-up-arrow', title: 'Look ahead', text: 'The pattern is projected forward. Add what you know — pay awards, grants ending, land sales — and watch the low point move.' },
  { icon: 'bi-bullseye', title: 'Test & share', text: 'Check how it would have performed in the past, then save for your team and export to Excel or a PDF report.' },
];

const BENEFITS = [
  { icon: 'bi-clock-history', title: 'Hours, not days', text: 'No more grouping thousands of bank lines by hand in Excel. Sorting a five-year history takes seconds.' },
  { icon: 'bi-bank', title: 'The real borrowing question', text: 'Loans and investments are kept out, so you see your underlying cash — and exactly when and how much you may need to borrow.' },
  { icon: 'bi-search', title: 'Every number explained', text: 'Each line records the rule that sorted it; each forecast figure traces back to history or to an assumption you made. Audit-friendly.' },
  { icon: 'bi-people', title: 'Your team’s knowledge, kept', text: 'Rules, bank layouts and forecasts live in one shared team file, so the tool gets better every time anyone uses it.' },
  { icon: 'bi-sliders', title: 'What-if in real time', text: 'Change a growth rate or add a one-off and the forecast, low point and plain-English summary update instantly.' },
  { icon: 'bi-file-earmark-text', title: 'Report-ready', text: 'Excel workbook and a clean printable summary for treasury reports and Section 151 briefings.' },
];

const SECURITY = [
  { icon: 'bi-pc-display', title: 'Runs on your computer', text: 'Bank files are read and processed inside this browser tab. There is no server behind this tool.' },
  { icon: 'bi-cloud-slash', title: 'Nothing is uploaded', text: 'No transaction data is sent anywhere — no uploads, no analytics, no tracking. The page is locked so it cannot contact any other website.' },
  { icon: 'bi-robot', title: 'No AI', text: 'Sorting uses clear, visible rules — never an AI service. You can see and change every rule.' },
  { icon: 'bi-file-earmark-lock', title: 'The team file holds no transactions', text: 'Only rules, layouts, categories and forecast totals are saved. Bank lines vanish when you close the tab.' },
];

export function HomePage() {
  const { goto, setStepTab, generateDemo, team, teamName, ingest } = useStore();
  const start = () => { setStepTab('load', 'team'); goto('load'); };
  const demo = () => { setStepTab('load', 'demo'); goto('load'); void generateDemo({ seed: 'northbridge', startFY: 2021, years: 5, preset: 'small', accounts: 4, nastiness: 1 }); };
  return (
    <div className="home">
      <section className="home-hero">
        <div className="home-hero-inner">
          <div className="pill-live"><span className="dot ok" /> A PWLBtoday tool · runs entirely in your browser</div>
          <h1>{APP_NAME_PARTS[0]}<span>{APP_NAME_PARTS[1]}</span></h1>
          <p className="home-lead">Turn your bank statements into a clear, explainable <strong>cash flow forecast</strong> — and see when your council will need to borrow, how much, and when it will have cash to invest.</p>
          <div className="row" style={{ gap: 12, marginTop: 24 }}>
            <button className="btn primary lg" onClick={start}><i className="bi bi-play-fill" /> Get started</button>
            <button className="btn lg on-dark" onClick={demo}><i className="bi bi-magic" /> Try it with demo data</button>
            {ingest && <button className="btn lg on-dark" onClick={() => goto('forecast')}>Continue where I was <i className="bi bi-arrow-right" /></button>}
          </div>
          <div className="home-trust">
            <span><i className="bi bi-shield-lock-fill" /> Bank data never leaves this computer</span>
            <span><i className="bi bi-eye" /> Every number explained</span>
            <span><i className="bi bi-stopwatch" /> Five years sorted in seconds</span>
          </div>
          {(teamName || team.savedAt) && <div className="home-team"><i className="bi bi-file-earmark-check" /> Team file loaded: <strong>{team.authorityName}</strong> · {team.rules.length} rules · {team.forecasts.length} saved forecast{team.forecasts.length === 1 ? '' : 's'}{team.savedAt ? ` · saved ${ago(team.savedAt)}` : ''}</div>}
        </div>
      </section>

      <div className="page" style={{ paddingTop: 36 }}>
        <section className="home-section">
          <div className="eyebrow">What it is</div>
          <h2>Your everyday cash, projected forward</h2>
          <div className="grid g2" style={{ alignItems: 'center' }}>
            <div className="small" style={{ fontSize: 15, lineHeight: 1.65 }}>
              <p>Treasury teams usually forecast by exporting bank statements into Excel and grouping thousands of lines by hand. {APP_NAME_PARTS.join('')} takes that tedious middle out.</p>
              <p>It sorts your transactions, sets aside borrowing and investment flows, learns the rhythm of your <strong>operational</strong> cash — when council tax arrives, when payroll and precepts go out, the February–March dip — and projects it forward.</p>
              <p style={{ marginBottom: 0 }}>The result is your <strong>underlying cash position</strong>: what you’d hold from everyday income and spending alone. Its low point is your borrowing need; its peaks are your opportunities to invest.</p>
            </div>
            <div className="home-illus" aria-hidden="true">
              <svg viewBox="0 0 440 210" width="100%">
                <defs><linearGradient id="hb" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#fd7e14" stopOpacity=".18" /><stop offset="1" stopColor="#fd7e14" stopOpacity="0" /></linearGradient></defs>
                <line x1="10" y1="70" x2="410" y2="70" stroke="#b04632" strokeDasharray="5 4" strokeWidth="1.5" />
                <text x="14" y="84" fontSize="11" fill="#b04632">minimum cash buffer</text>
                <path d="M10 60 C40 40,60 80,90 50 S140 70,170 55 S205 95,220 90" fill="none" stroke="#0a2540" strokeWidth="3" />
                <path d="M220 90 C250 70,270 120,300 100 S340 150,360 150 S390 120,410 135" fill="none" stroke="#fd7e14" strokeWidth="3" strokeDasharray="7 5" />
                <path d="M220 90 C250 60,270 100,300 80 S340 120,360 120 S390 95,410 105 L410 165 C390 150,370 180,360 180 S330 170,300 120 S250 90,220 90Z" fill="url(#hb)" />
                <line x1="220" y1="20" x2="220" y2="185" stroke="#ced4da" />
                <text x="226" y="30" fontSize="11" fill="#6c757d">today</text>
                <circle cx="360" cy="150" r="6" fill="#b04632" stroke="#fff" strokeWidth="2" />
                <text x="250" y="200" fontSize="12" fontWeight="700" fill="#b04632">low point = borrowing need</text>
                <text x="100" y="30" fontSize="11" fill="#0a2540">history</text>
                <text x="300" y="60" fontSize="11" fill="#fd7e14">forecast</text>
              </svg>
            </div>
          </div>
        </section>

        <section className="home-section">
          <div className="eyebrow">How it works</div>
          <h2>Six stages, guided all the way</h2>
          <p className="muted">Every screen tells you what you’re looking at, why it matters and what to do. Most of the work is automatic — you mostly confirm.</p>
          <div className="home-steps">
            {STAGES.map((s, i) => (
              <div key={s.title} className="home-step">
                <div className="home-step-n">{i + 1}</div>
                <i className={`bi ${s.icon}`} />
                <h4>{s.title}</h4>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="home-section">
          <div className="eyebrow">Why use it</div>
          <h2>What you get</h2>
          <div className="grid g3">
            {BENEFITS.map((b) => (
              <div key={b.title} className="home-card"><i className={`bi ${b.icon}`} /><h4>{b.title}</h4><p>{b.text}</p></div>
            ))}
          </div>
        </section>

        <section className="home-section home-security">
          <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.6fr)', gap: 32, alignItems: 'start' }}>
            <div>
              <div className="eyebrow" style={{ color: 'var(--pt-mint)' }}>Data security</div>
              <h2 style={{ color: '#fff' }}>Your bank data stays on this computer</h2>
              <p style={{ color: 'rgba(255,255,255,.8)' }}>This was the first design rule, not an afterthought. It’s built so that sending your data anywhere is not just avoided — it’s technically blocked.</p>
              <div className="callout" style={{ background: 'rgba(255,255,255,.06)', borderColor: 'var(--pt-mint)', color: 'rgba(255,255,255,.88)' }}>
                <strong style={{ color: '#fff' }}>Your IT team can check this.</strong> Open the browser’s developer tools, Network tab, and use the tool: after the page loads, there are no requests at all. The README explains the full five-minute check.
              </div>
            </div>
            <div className="grid g2">
              {SECURITY.map((s) => (
                <div key={s.title} className="home-sec-card"><i className={`bi ${s.icon}`} /><h4>{s.title}</h4><p>{s.text}</p></div>
              ))}
            </div>
          </div>
        </section>

        <section className="home-section">
          <div className="eyebrow">Before you start</div>
          <h2>What you need</h2>
          <div className="grid g3">
            <div className="home-card"><i className="bi bi-filetype-csv" /><h4>Bank statement exports</h4><p>CSV files from your bank’s online banking — ideally three to five years, for each account you want included. Any layout works.</p></div>
            <div className="home-card"><i className="bi bi-folder2-open" /><h4>Your team file (if you have one)</h4><p>The shared JSON file from your team drive. First time? You’ll create one at the end.</p></div>
            <div className="home-card"><i className="bi bi-hourglass-split" /><h4>About 20 minutes the first time</h4><p>Mostly the review step. After that, with your team file, a refresh takes a few minutes.</p></div>
          </div>
          <div className="home-cta">
            <div><h3 style={{ margin: 0 }}>Ready?</h3><div className="muted">Start with your own files, or explore with a realistic demo council first.</div></div>
            <div className="row"><button className="btn primary lg" onClick={start}><i className="bi bi-play-fill" /> Get started</button><button className="btn lg" onClick={demo}><i className="bi bi-magic" /> Try the demo</button></div>
          </div>
        </section>
      </div>
    </div>
  );
}
