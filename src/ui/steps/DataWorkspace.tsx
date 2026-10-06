import { useState } from 'react';
import { useStore } from '../../state/store';
import { PageHead, Panel, CategorySelect, Seg } from '../components/common';
import { TxnTable } from '../components/TxnTable';
import { LoadStep } from './LoadStep';
import { MappingStep } from './MappingStep';
import { CategoriseStep } from './CategoriseStep';
import { ReviewStep } from './ReviewStep';
import { DataQuality } from './HistoryStep';
import type { TxnFilter } from '../../worker/types';
import { F_OUTLIER, F_DEAL_LIKE_OP, F_DUP, F_LOAN_PAIR } from '../../lib/categorise/engine';

const EMPTY: string[] = [];

type Tab = 'files' | 'mapping' | 'categorise' | 'review' | 'transactions' | 'quality';

/** Workspace "Data" tab: the first four wizard steps plus a transaction browser, side by side. */
export function DataWorkspace() {
  const [tab, setTab] = useState<Tab>('review');
  const cat = useStore((s) => s.cat);
  return (
    <div>
      <div className="page" style={{ paddingBottom: 0 }}>
        <PageHead eyebrow="Workspace" title="Data">Files, mapping, categorisation and review — everything that turns bank lines into clean, categorised cash flows.</PageHead>
        <div className="tabs" role="tablist">
          {([['files', 'Files', 'bi-cloud-arrow-up'], ['mapping', 'Mapping', 'bi-layout-three-columns'], ['categorise', 'Categorisation', 'bi-tags'], ['review', 'Review', 'bi-ui-checks'], ['transactions', 'Transactions', 'bi-list-ul'], ['quality', 'Data quality', 'bi-clipboard-check']] as [Tab, string, string][]).map(([k, l, i]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} disabled={!cat && k !== 'files'} onClick={() => setTab(k)}><i className={`bi ${i}`} /> {l}</button>
          ))}
        </div>
      </div>
      <div className="ws-embed">
        {tab === 'files' && <LoadStep />}
        {tab === 'mapping' && <MappingStep />}
        {tab === 'categorise' && <CategoriseStep />}
        {tab === 'review' && <div className="page" style={{ paddingTop: 0 }}><ReviewStep embedded /></div>}
        {tab === 'transactions' && <Transactions />}
        {tab === 'quality' && <div className="page" style={{ paddingTop: 0 }}><DataQuality /></div>}
      </div>
    </div>
  );
}

function Transactions() {
  const categories = useStore((s) => s.team.categories);
  const catIds = useStore((s) => s.cat?.catIds ?? EMPTY);
  const accounts = useStore((s) => s.ingest?.accounts ?? EMPTY);
  const [catId, setCatId] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [deal, setDeal] = useState<'any' | 'deal' | 'operational'>('any');
  const [flag, setFlag] = useState(0);
  const [account, setAccount] = useState('');
  const [sort, setSort] = useState<'day_desc' | 'day' | 'abs_desc'>('day_desc');
  const filter: TxnFilter = {
    catIdx: catId === '__unc__' || !catId ? null : catIds.indexOf(catId), uncategorised: catId === '__unc__',
    search: q || undefined, deal, flagMask: flag || undefined, account: account || undefined, sort,
  };
  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <Panel title="Transactions" sub="every line, virtualised — hover a narrative for its signature, rule and source line" flush>
        <div className="row card-pad" style={{ paddingBottom: 8 }}>
          <input className="input" style={{ width: 240 }} placeholder="Search narrative…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setQ(search); }} onBlur={() => setQ(search)} />
          <div style={{ width: 220 }}><CategorySelect value={catId} onChange={setCatId} categories={categories} allowNone="All categories" /></div>
          <select className="select" style={{ width: 150 }} value={catId === '__unc__' ? '__unc__' : ''} onChange={(e) => setCatId(e.target.value)}><option value="">—</option><option value="__unc__">Uncategorised only</option></select>
          <Seg value={deal} onChange={setDeal} options={[{ v: 'any', label: 'All' }, { v: 'operational', label: 'Operational' }, { v: 'deal', label: 'Treasury' }]} />
          <select className="select" style={{ width: 170 }} value={flag} onChange={(e) => setFlag(+e.target.value)}><option value={0}>Any flags</option><option value={F_OUTLIER}>Outliers</option><option value={F_DEAL_LIKE_OP}>Deal-like operational</option><option value={F_LOAN_PAIR}>Loan pairs</option><option value={F_DUP}>Possible duplicates</option></select>
          <select className="select" style={{ width: 150 }} value={account} onChange={(e) => setAccount(e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a}>{a}</option>)}</select>
          <select className="select" style={{ width: 150 }} value={sort} onChange={(e) => setSort(e.target.value as 'day')}><option value="day_desc">Newest first</option><option value="day">Oldest first</option><option value="abs_desc">Largest first</option></select>
        </div>
        <TxnTable filter={filter} height={600} />
      </Panel>
    </div>
  );
}
