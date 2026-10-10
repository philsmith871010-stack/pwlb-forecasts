// The landing page: what the tool is, in one screen, and the way in.
import { useStore } from '../../state/store';
import { APP_NAME_PARTS } from '../../config';

const JOBS = [
  { icon: 'bi-calendar-day', title: 'Today’s statement', text: 'Drop it in; it’s sorted in seconds and joins your history.' },
  { icon: 'bi-bar-chart-line', title: 'History', text: 'Years of bank statements, sorted once, so you can see how your cash behaves.' },
  { icon: 'bi-graph-up-arrow', title: 'Forecast', text: 'When you’ll need to borrow, how much, and your options, with a ready-made report.' },
];

export function HomePage() {
  const { enter } = useStore();
  return (
    <div className="home landing-one">
      <section className="home-hero landing">
        <div className="home-hero-inner">
          <div className="landing-top">
            <div>
              <div className="pill-live"><span className="dot ok" /> A PWLBtoday tool · runs entirely in your browser</div>
              <h1>{APP_NAME_PARTS[0]}<span>{APP_NAME_PARTS[1]}</span></h1>
              <p className="home-lead">Your council’s bank statements, sorted, understood and forecast.</p>
              <div className="landing-ctas">
                <button className="btn primary xl" onClick={() => void enter('mine')}>Enter <i className="bi bi-arrow-right" /></button>
                <button className="btn xl on-dark" onClick={() => void enter('example')}><i className="bi bi-stars" /> Explore the example council</button>
              </div>
            </div>
            <Preview />
          </div>
          <div className="landing-jobs">
            {JOBS.map((j) => (
              <div key={j.title} className="landing-job"><i className={`bi ${j.icon}`} /><div><strong>{j.title}</strong><span>{j.text}</span></div></div>
            ))}
          </div>
          <div className="home-trust">
            <span><i className="bi bi-shield-lock-fill" /> Bank data never leaves this computer</span>
            <span><i className="bi bi-robot" /> No AI: clear rules you can see</span>
            <span><i className="bi bi-eye" /> Every number explained</span>
          </div>
        </div>
      </section>
    </div>
  );
}

/** An illustration of what a forecast looks like: the past, the forecast and its likely range. */
function Preview() {
  return (
    <div className="landing-preview" aria-hidden="true">
      <div className="lp-kpis">
        <div><span>May need to borrow</span><strong>£24.5m</strong><em>by Feb 2028</em></div>
        <div><span>Lowest point</span><strong className="neg">−£14.5m</strong><em>Feb 2028</em></div>
      </div>
      <svg viewBox="0 0 320 150" className="lp-chart">
        <line x1="0" y1="62" x2="320" y2="62" className="lp-min" />
        <text x="4" y="57" className="lp-label">minimum cash</text>
        <line x1="150" y1="8" x2="150" y2="142" className="lp-today" />
        <path d="M150 50 C185 58,215 70,250 96 S300 128,320 120 L320 142 C290 150,250 128,215 96 S180 60,150 54 Z" className="lp-band" />
        <path d="M0 40 L12 34 L24 42 L36 30 L48 36 L60 26 L72 38 L84 32 L96 44 L108 36 L120 48 L132 42 L150 52" className="lp-past" />
        <path d="M150 52 L165 56 L180 54 L195 66 L210 72 L225 80 L240 96 L255 104 L270 112 L285 122 L300 126 L310 120 L320 124" className="lp-fc" />
        <circle cx="300" cy="126" r="4" className="lp-low" />
      </svg>
      <div className="lp-legend"><span className="past">Past</span><span className="fc">Forecast</span><span className="band">Likely range</span></div>
    </div>
  );
}
