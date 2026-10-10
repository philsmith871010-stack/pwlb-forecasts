import { useStore } from '../../state/store';
import { APP_NAME_PARTS } from '../../config';


const STAGES = [
  { icon: 'bi-calendar-day', title: 'Today’s statement', text: 'Drop in today’s bank statement. It’s sorted with your team’s rules in seconds, you sort anything new, and the day joins your history.' },
  { icon: 'bi-bar-chart-line', title: 'History', text: 'Load years of statements once. Check the sorting, then see how your cash behaves: year by year and through the seasons.' },
  { icon: 'bi-graph-up-arrow', title: 'Forecast', text: 'Check our proposal line by line, add what you know is coming, and see when you’d need to borrow, with options and a ready-made report.' },
];

const BENEFITS = [
  { icon: 'bi-clock-history', title: 'Hours, not days', text: 'No more grouping thousands of bank lines by hand in Excel. Sorting a five-year history takes seconds.' },
  { icon: 'bi-bank', title: 'The real borrowing question', text: 'Loans and investments are kept out, so you see your underlying cash — and exactly when and how much you may need to borrow.' },
  { icon: 'bi-journal-check', title: 'Works with your deal register', text: 'Add your PWLBtoday deal register and the forecast includes loan repayments and maturing investments, then sets out borrowing and investing options alongside your liability benchmark.' },
  { icon: 'bi-search', title: 'Every number explained', text: 'Each line records the rule that sorted it; each forecast figure traces back to history or to an assumption you made. Audit-friendly.' },
  { icon: 'bi-people', title: 'Your team’s knowledge, kept', text: 'Every sorting decision, payment pattern and forecast is remembered, so the tool gets better every time it’s used.' },
  { icon: 'bi-sliders', title: 'What-if in real time', text: 'Change a growth rate or add a one-off and the forecast, low point and plain-English summary update instantly — then download a ready-made report.' },
];

const SECURITY = [
  { icon: 'bi-pc-display', title: 'Runs on your computer', text: 'Bank files are read and processed inside this browser tab. There is no server behind this tool.' },
  { icon: 'bi-cloud-slash', title: 'Nothing is uploaded', text: 'No transaction data is sent anywhere — no uploads, no analytics, no tracking. The page is locked so it cannot contact any other website.' },
  { icon: 'bi-robot', title: 'No AI', text: 'Sorting uses clear, visible rules — never an AI service. You can see and change every rule.' },
  { icon: 'bi-file-earmark-lock', title: 'No bank lines are kept', text: 'Your work is saved in this browser: rules, forecasts and a cash history of daily totals by category and regular payments. Never individual bank lines. Your deal register is forgotten when you close the tab.' },
];

export function HomePage() {
  const { enter } = useStore();
  return (
    <div className="home">
      <section className="home-hero landing">
        <div className="home-hero-inner">
          <div className="pill-live"><span className="dot ok" /> A PWLBtoday tool · runs entirely in your browser</div>
          <h1>{APP_NAME_PARTS[0]}<span>{APP_NAME_PARTS[1]}</span></h1>
          <p className="home-lead">Your council’s cash, sorted, understood and forecast: today’s bank statement in seconds, years of history at a glance, and when you’ll need to borrow.</p>
          <div className="landing-ctas">
            <button className="btn primary xl" onClick={() => void enter('mine')}>Enter <i className="bi bi-arrow-right" /></button>
            <button className="btn xl on-dark" onClick={() => void enter('example')}><i className="bi bi-stars" /> Explore the example council</button>
          </div>
          <div className="home-trust">
            <span><i className="bi bi-shield-lock-fill" /> Bank data never leaves this computer</span>
            <span><i className="bi bi-eye" /> Every number explained</span>
            <span><i className="bi bi-stopwatch" /> Five years sorted in seconds</span>
          </div>
        </div>
      </section>

      <nav className="home-nav" aria-label="On this page">
        <span className="home-nav-label">About this tool</span>
        {[['what', 'What it is'], ['how', 'What you can do'], ['benefits', 'What you get'], ['security', 'Your data is safe'], ['start', 'What you need']].map(([id, l]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{l}</a>
        ))}
      </nav>
      <div className="page" style={{ paddingTop: 36 }}>
        <section className="home-section" id="what">
          <div className="eyebrow">What it is</div>
          <h2>Your everyday cash, projected forward</h2>
          <div className="grid g2" style={{ alignItems: 'center' }}>
            <div className="small" style={{ fontSize: 15, lineHeight: 1.65 }}>
              <p>Most councils forecast cash by downloading bank statements into Excel and sorting thousands of lines by hand. {APP_NAME_PARTS.join('')} takes that tedious middle out.</p>
              <p>This tool does the sorting for you. It sets aside loans and investments, learns the rhythm of your <strong>everyday cash</strong> — when council tax arrives, when salaries go out, the dip every February and March — and carries that pattern forward.</p>
              <p style={{ marginBottom: 0 }}>You check each line of the proposal, add what you know, and only then see the forecast. Add your deal register and it includes your loans and investments too. Where it dips lowest is how much you may need to <strong>borrow</strong>; where it peaks is your chance to <strong>invest</strong>.</p>
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

        <section className="home-section" id="how">
          <div className="eyebrow">What you can do</div>
          <h2>Three jobs, one menu</h2>
          <p className="muted">Use whichever you need: today’s statement for day-to-day work, history for a periodic deep look, the forecast for the borrowing question. Most of the work is automatic.</p>
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

        <section className="home-section" id="benefits">
          <div className="eyebrow">Why use it</div>
          <h2>What you get</h2>
          <div className="grid g3">
            {BENEFITS.map((b) => (
              <div key={b.title} className="home-card"><i className={`bi ${b.icon}`} /><h4>{b.title}</h4><p>{b.text}</p></div>
            ))}
          </div>
        </section>

        <section className="home-section home-security" id="security">
          <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.6fr)', gap: 32, alignItems: 'start' }}>
            <div>
              <div className="eyebrow" style={{ color: 'var(--pt-mint)' }}>Data security</div>
              <h2 style={{ color: '#fff' }}>Your bank data stays on this computer</h2>
              <p style={{ color: 'rgba(255,255,255,.8)' }}>This was the first rule when the tool was designed. Sending your data anywhere isn’t just avoided — the tool is built so that it can’t.</p>
              <div className="callout" style={{ background: 'rgba(255,255,255,.06)', borderColor: 'var(--pt-mint)', color: 'rgba(255,255,255,.88)' }}>
                <strong style={{ color: '#fff' }}>Your IT team can check this for themselves</strong> in a few minutes — the instructions come with the tool. In short: once the page has opened, it makes no further contact with the internet at all.
              </div>
            </div>
            <div className="grid g2">
              {SECURITY.map((s) => (
                <div key={s.title} className="home-sec-card"><i className={`bi ${s.icon}`} /><h4>{s.title}</h4><p>{s.text}</p></div>
              ))}
            </div>
          </div>
        </section>

        <section className="home-section" id="start">
          <div className="eyebrow">Before you start</div>
          <h2>What you need</h2>
          <div className="grid g2">
            <div className="home-card"><i className="bi bi-filetype-csv" /><h4>Bank statement exports</h4><p>CSV files downloaded from online banking — ideally three to five years. Any bank, any layout. Or use our example data.</p></div>
            <div className="home-card"><i className="bi bi-journal-text" /><h4>Your deal register (recommended)</h4><p>The PWLBtoday workbook of your loans and investments, so the forecast includes repayments, interest and maturities. Have schedules from other departments, such as grant dates? You can import those too.</p></div>
            <div className="home-card"><i className="bi bi-floppy" /><h4>Nothing to save</h4><p>Your work is saved in this browser as you go. You can download a copy from the settings menu at any time.</p></div>
            <div className="home-card"><i className="bi bi-hourglass-split" /><h4>About 15 minutes the first time</h4><p>Most of it is checking a few items. After that it remembers your history: add just today’s statement, or the latest quarter for a review.</p></div>
          </div>
          <div className="home-cta">
            <div><h3 style={{ margin: 0 }}>Ready?</h3><div className="muted">Start with your own bank files, or explore with a realistic example council first.</div></div>
            <div className="row"><button className="btn primary lg" onClick={() => void enter('mine')}>Enter <i className="bi bi-arrow-right" /></button><button className="btn lg" onClick={() => void enter('example')}><i className="bi bi-stars" /> Explore the example council</button></div>
          </div>
        </section>
      </div>
    </div>
  );
}
