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
          <div className="pill-live"><span className="dot ok" /> A PWLBtoday tool · runs entirely in your browser</div>
          <h1>{APP_NAME_PARTS[0]}<span>{APP_NAME_PARTS[1]}</span></h1>
          <p className="home-lead">Your council’s bank statements, sorted, understood and forecast.</p>
          <div className="landing-ctas">
            <button className="btn primary xl" onClick={() => void enter('mine')}>Enter <i className="bi bi-arrow-right" /></button>
            <button className="btn xl on-dark" onClick={() => void enter('example')}><i className="bi bi-stars" /> Explore the example council</button>
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
