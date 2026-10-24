import { useEffect, useRef, useState } from 'react';
import './App.css';
import { SkillReviewModal } from './components/SkillReviewModal';

interface Job {
  id: number;
  title: string;
  company: string;
  location: string | null;
  published: string | null;
  deadline: string | null;
  descriptionSnippet: string | null;
  url: string;
  source: string;
  status: string;
  fit_score: number | null;
  fit_reason?: string | null;
}

interface DistilledStatus {
  exists: boolean;
  content: string;
  source_stale: boolean;
  scoring_with: 'distilled' | 'raw' | null;
  max_chars: number;
}

type SortOption = 
  | 'newest'
  | 'oldest'
  | 'score_desc'
  | 'score_asc'
  | 'deadline_asc'
  | 'deadline_desc'
  | 'company_asc'
  | 'title_asc';

interface FilterState {
  sortBy: SortOption;
  searchQuery: string;
  minScore: number;
  scoreStatus: 'all' | 'scored_only' | 'unscored_only';
  source: 'all' | 'op_kiitorata_2027' | 'duunitori_auto' | 'extension';
  location: string;
  deadlineOnly: boolean;
  upcomingOnly: boolean;
}

const DEFAULT_FILTERS: FilterState = {
  sortBy: 'newest',
  searchQuery: '',
  minScore: 0,
  scoreStatus: 'all',
  source: 'all',
  location: '',
  deadlineOnly: false,
  upcomingOnly: false,
};

interface ScoringProgress {
  isRunning: boolean;
  total: number;
  completed: number;
  failed?: number;
  stopped?: string | null;
  currentJob: string;
}

// What the "Re-score saved jobs" button needs to know (GET /api/profile/rescore).
interface RescoreStatus {
  scoring_with: 'distilled' | 'raw' | null;
  saved_total: number;
  current: number;        // saved jobs already scored with the current profile
  to_rescore: number;     // saved jobs a run would score
  no_text: number;        // saved jobs that are stale but have no stored ad text
  short_text: number;     // of to_rescore: only a shortened ad text is stored
  model: string;
  interval_seconds: number;
  estimated_seconds: number;
  running: boolean;
}

function App() {
  const [jobs, setJobs] = useState<Job[]>([]);

  // Batch Scoring Progress State (SSE)
  const [progress, setProgress] = useState<ScoringProgress>({
    isRunning: false,
    total: 0,
    completed: 0,
    currentJob: ''
  });

  // Re-scoring saved jobs after the profile changes
  const [rescore, setRescore] = useState<RescoreStatus | null>(null);
  const [rescoreMsg, setRescoreMsg] = useState("");

  // Profile Document State
  const [documents, setDocuments] = useState<{id: number, title: string, content: string}[]>([]);
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocContent, setNewDocContent] = useState("");
  
  // Settings State
  const [settings, setSettings] = useState<Record<string, string>>({});
  
  const [showSettings, setShowSettings] = useState(false);

  // Distilled Profile State
  const [distilled, setDistilled] = useState<DistilledStatus | null>(null);
  const [distilledText, setDistilledText] = useState("");
  const [distilledBusy, setDistilledBusy] = useState(false);
  const [distilledMsg, setDistilledMsg] = useState("");
  const distilledDirty = useRef(false); // true while the editor holds text that isn't saved yet

  const fetchData = async () => {
    try {
      const [jobRes, docRes, setRes, profRes, rescoreRes] = await Promise.all([
        fetch('/api/jobs'),
        fetch('/api/documents'),
        fetch('/api/settings'),
        fetch('/api/profile/distilled'),
        fetch('/api/profile/rescore')
      ]);
      setJobs(await jobRes.json());
      setDocuments(await docRes.json());
      setRescore(await rescoreRes.json());
      setSettings(await setRes.json());
      const profile: DistilledStatus = await profRes.json();
      setDistilled(profile);
      if (!distilledDirty.current) setDistilledText(profile.content); // never overwrite unsaved edits
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchData();

    // Setup Server-Sent Events (SSE) for real-time scoring updates
    const eventSource = new EventSource('/api/jobs/score-stream');

    eventSource.addEventListener('state', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setProgress(data);
      } catch (err) {
        console.error('Error parsing SSE state:', err);
      }
    });

    eventSource.addEventListener('job_scored', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setProgress({
          isRunning: true,
          total: data.total,
          completed: data.completed,
          failed: data.failed,
          currentJob: data.currentJob
        });
        if (data.job) {
          setJobs(prevJobs => prevJobs.map(j => j.id === data.job.id ? { ...j, ...data.job } : j));
        }
      } catch (err) {
        console.error('Error parsing SSE job_scored:', err);
      }
    });

    eventSource.addEventListener('done', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setProgress({
          isRunning: false,
          total: data.total,
          completed: data.completed,
          failed: data.failed,
          stopped: data.stopped,
          currentJob: ''
        });
        fetchData(); // also refreshes the re-score button
      } catch (err) {
        console.error('Error parsing SSE done:', err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, []);

  const updateStatus = async (id: number, newStatus: string) => {
    try {
      await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      fetchData(); // re-fetch jobs
    } catch (e) {
      console.error(e);
    }
  };

  const [scoringJobs, setScoringJobs] = useState<Set<number>>(new Set());

  const scoreJob = async (id: number) => {
    setScoringJobs(prev => new Set(prev).add(id));
    try {
      await fetch(`/api/jobs/${id}/score`, { method: 'POST' });
      fetchData(); // re-fetch jobs to get the score
    } catch (e) {
      console.error(e);
    } finally {
      setScoringJobs(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const [exportingJobs, setExportingJobs] = useState<Set<number>>(new Set());

  const exportToObsidian = async (id: number) => {
    setExportingJobs(prev => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/jobs/${id}/export-to-obsidian`, {
        method: 'POST'
      });
      if (!res.ok) {
        throw new Error('Failed to export to Obsidian');
      }
      const data = await res.json();
      await fetchData();
      if (data.obsidian_uri) {
        window.location.href = data.obsidian_uri;
      }
    } catch (e) {
      console.error(e);
      alert('Error exporting note to Obsidian.');
    } finally {
      setExportingJobs(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const [reviewModalState, setReviewModalState] = useState<{
    isOpen: boolean;
    job: Job | null;
    action: 'reject' | 'apply';
  }>({
    isOpen: false,
    job: null,
    action: 'reject'
  });

  const openSkillModal = (job: Job, action: 'reject' | 'apply') => {
    setReviewModalState({
      isOpen: true,
      job,
      action
    });
  };

  const closeSkillModal = () => {
    setReviewModalState(prev => ({ ...prev, isOpen: false, job: null }));
  };

  const handleConfirmReview = async (jobId: number, skills: string[], action: 'reject' | 'apply') => {
    try {
      // 1. Save skills to catalog & update status in SQLite
      await fetch(`/api/jobs/${jobId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skills,
          update_status: action === 'reject' ? 'rejected' : 'applied'
        })
      });

      // 2. If action is apply, export rich note to Obsidian vault
      if (action === 'apply') {
        const res = await fetch(`/api/jobs/${jobId}/export-to-obsidian`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          if (data.obsidian_uri) {
            window.location.href = data.obsidian_uri;
          }
        }
      }

      await fetchData();
    } catch (e) {
      console.error(e);
      alert('Error saving skills or updating status.');
    }
  };

  const handleSkipReview = async (jobId: number, action: 'reject' | 'apply') => {
    try {
      if (action === 'reject') {
        await updateStatus(jobId, 'rejected');
      } else {
        await exportToObsidian(jobId);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);

  const resetFilters = () => setFilters(DEFAULT_FILTERS);

  const getActiveFilterCount = () => {
    let count = 0;
    if (filters.sortBy !== 'newest') count++;
    if (filters.searchQuery.trim() !== '') count++;
    if (filters.minScore > 0) count++;
    if (filters.scoreStatus !== 'all') count++;
    if (filters.source !== 'all') count++;
    if (filters.location.trim() !== '') count++;
    if (filters.deadlineOnly) count++;
    if (filters.upcomingOnly) count++;
    return count;
  };

  const todayISO = new Date().toISOString().split('T')[0];

  const getFilteredJobs = (status: string) => {
    let list = jobs.filter(j => j.status === status);

    // 1. Text Search
    if (filters.searchQuery.trim() !== '') {
      const q = filters.searchQuery.toLowerCase().trim();
      list = list.filter(j => 
        j.title.toLowerCase().includes(q) ||
        j.company.toLowerCase().includes(q) ||
        (j.location && j.location.toLowerCase().includes(q)) ||
        (j.fit_reason && j.fit_reason.toLowerCase().includes(q)) ||
        (j.descriptionSnippet && j.descriptionSnippet.toLowerCase().includes(q))
      );
    }

    // 2. Minimum Fit Score
    if (filters.minScore > 0) {
      list = list.filter(j => j.fit_score !== null && j.fit_score >= filters.minScore);
    }

    // 3. Scoring Status
    if (filters.scoreStatus === 'scored_only') {
      list = list.filter(j => j.fit_score !== null);
    } else if (filters.scoreStatus === 'unscored_only') {
      list = list.filter(j => j.fit_score === null);
    }

    // 4. Source Platform
    if (filters.source !== 'all') {
      if (filters.source === 'op_kiitorata_2027') {
        list = list.filter(j => j.source === 'op_kiitorata_2027' || j.url.includes('op-careers.fi'));
      } else {
        list = list.filter(j => j.source === filters.source);
      }
    }

    // 5. Location
    if (filters.location.trim() !== '') {
      const loc = filters.location.toLowerCase().trim();
      list = list.filter(j => (j.location || '').toLowerCase().includes(loc));
    }

    // 6. Deadline Filter
    if (filters.deadlineOnly) {
      list = list.filter(j => j.deadline && j.deadline.trim() !== '');
    }
    if (filters.upcomingOnly) {
      list = list.filter(j => j.deadline && j.deadline >= todayISO);
    }

    // 7. Sorting
    list.sort((a, b) => {
      switch (filters.sortBy) {
        case 'newest':
          return b.id - a.id;
        case 'oldest':
          return a.id - b.id;
        case 'score_desc': {
          const scoreA = a.fit_score !== null ? a.fit_score : -1;
          const scoreB = b.fit_score !== null ? b.fit_score : -1;
          if (scoreB !== scoreA) return scoreB - scoreA;
          return b.id - a.id;
        }
        case 'score_asc': {
          const scoreA = a.fit_score !== null ? a.fit_score : 999;
          const scoreB = b.fit_score !== null ? b.fit_score : 999;
          if (scoreA !== scoreB) return scoreA - scoreB;
          return b.id - a.id;
        }
        case 'deadline_asc': {
          const dlA = a.deadline || '';
          const dlB = b.deadline || '';
          if (dlA && dlB) {
            const cmp = dlA.localeCompare(dlB);
            if (cmp !== 0) return cmp;
          } else if (dlA && !dlB) {
            return -1; // jobs with deadlines first
          } else if (!dlA && dlB) {
            return 1;
          }
          return b.id - a.id;
        }
        case 'deadline_desc': {
          const dlA = a.deadline || '';
          const dlB = b.deadline || '';
          if (dlA && dlB) {
            const cmp = dlB.localeCompare(dlA);
            if (cmp !== 0) return cmp;
          } else if (dlA && !dlB) {
            return -1;
          } else if (!dlA && dlB) {
            return 1;
          }
          return b.id - a.id;
        }
        case 'company_asc': {
          const cmp = a.company.localeCompare(b.company);
          if (cmp !== 0) return cmp;
          return b.id - a.id;
        }
        case 'title_asc': {
          const cmp = a.title.localeCompare(b.title);
          if (cmp !== 0) return cmp;
          return b.id - a.id;
        }
        default:
          return b.id - a.id;
      }
    });

    return list;
  };

  const getSortLabel = (sb: SortOption) => {
    switch (sb) {
      case 'newest': return 'Newest';
      case 'oldest': return 'Oldest';
      case 'score_desc': return 'Best Score';
      case 'score_asc': return 'Lowest Score';
      case 'deadline_asc': return 'Soonest Deadline';
      case 'deadline_desc': return 'Furthest Deadline';
      case 'company_asc': return 'Company A-Z';
      case 'title_asc': return 'Title A-Z';
      default: return sb;
    }
  };

  const updateSetting = async (key: string, value: string) => {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      });
      fetchData(); // re-fetch to get masked value
    } catch (e) {
      console.error(e);
    }
  };

  const addDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocTitle.trim() || !newDocContent.trim()) return;
    try {
      await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newDocTitle.trim(), content: newDocContent.trim() })
      });
      setNewDocTitle("");
      setNewDocContent("");
      fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  const deleteDocument = async (id: number) => {
    try {
      await fetch(`/api/documents/${id}`, { method: 'DELETE' });
      fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  const errorText = (data: { detail?: unknown }, fallback: string) =>
    typeof data.detail === 'string' ? data.detail : fallback;

  const generateDistilledDraft = async () => {
    if (distilledDirty.current && !window.confirm('Replace your unsaved edits with a new draft?')) return;
    setDistilledBusy(true);
    setDistilledMsg("");
    try {
      const res = await fetch('/api/profile/distilled/draft', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setDistilledMsg(errorText(data, 'Could not generate a draft.'));
        return;
      }
      setDistilledText(data.content);
      distilledDirty.current = true;
      setDistilledMsg('Draft generated, nothing is saved yet. Review it, fill in your preferences, then save.');
    } catch (e) {
      console.error(e);
      setDistilledMsg('Could not reach the backend.');
    } finally {
      setDistilledBusy(false);
    }
  };

  const saveDistilled = async () => {
    setDistilledBusy(true);
    setDistilledMsg("");
    try {
      const res = await fetch('/api/profile/distilled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: distilledText })
      });
      const data = await res.json();
      if (!res.ok) {
        setDistilledMsg(errorText(data, 'The profile text is empty or too long.'));
        return;
      }
      distilledDirty.current = false;
      setDistilled(data);
      setDistilledText(data.content);
      const status = await refreshRescoreStatus();
      setDistilledMsg(status && status.to_rescore > 0
        ? `Saved. ${status.to_rescore} saved job${status.to_rescore === 1 ? ' was' : 's were'} scored with an older profile: re-score ${status.to_rescore === 1 ? 'it' : 'them'} below.`
        : 'Saved.');
    } catch (e) {
      console.error(e);
      setDistilledMsg('Could not reach the backend.');
    } finally {
      setDistilledBusy(false);
    }
  };

  const removeDistilled = async () => {
    if (!window.confirm('Delete the distilled profile and score with your full documents again?')) return;
    setDistilledBusy(true);
    try {
      const res = await fetch('/api/profile/distilled', { method: 'DELETE' });
      const data: DistilledStatus = await res.json();
      distilledDirty.current = false;
      setDistilled(data);
      setDistilledText("");
      const status = await refreshRescoreStatus();
      setDistilledMsg(status && status.to_rescore > 0
        ? `Deleted. Scoring uses your full documents again. ${status.to_rescore} saved job${status.to_rescore === 1 ? '' : 's'} can be re-scored below.`
        : 'Deleted. Scoring uses your full documents.');
    } catch (e) {
      console.error(e);
      setDistilledMsg('Could not reach the backend.');
    } finally {
      setDistilledBusy(false);
    }
  };

  const JobCard = ({ job }: { job: Job }) => {
    const isScoring = scoringJobs.has(job.id);
    const isOpJob = job.source === 'op_kiitorata_2027' || job.url.includes('op-careers.fi');
    const isExpired = job.deadline ? job.deadline < todayISO : false;

    return (
    <div className="job-card">
      <div className="job-header">
        <h3>
          <a href={job.url} target="_blank" rel="noreferrer">{job.title}</a>
          {job.fit_score !== null && (
            <span style={{float: 'right', color: job.fit_score >= 80 ? '#36b37e' : job.fit_score >= 60 ? '#ff991f' : '#bf2600'}}>
              Score: {job.fit_score}
            </span>
          )}
        </h3>
      </div>
      <div className="job-meta">
        <span className="company">{job.company}</span>
        <span className="location">{job.location || 'Remote/Unknown'}</span>
      </div>

      <div style={{display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center'}}>
        {job.deadline && (
          <span className={`badge-deadline ${isExpired ? 'expired' : ''}`} title={isExpired ? 'Deadline expired' : 'Application deadline'}>
            📅 Deadline: {job.deadline} {isExpired ? '(Expired)' : ''}
          </span>
        )}
        {isOpJob && (
          <span className="badge-source op-source">
            🚀 OP Kiitorata 2027
          </span>
        )}
        {job.published && (
          <span style={{fontSize: '0.75rem', color: '#6b778c'}}>
            Published: {job.published}
          </span>
        )}
      </div>

      {job.fit_reason && (
        <div style={{fontSize: '0.8rem', fontStyle: 'italic', color: '#42526e', marginTop: '0.2rem'}}>
          {job.fit_reason}
        </div>
      )}
      
      <div className="actions">
        {job.fit_score === null && (
          <button 
            className="btn outline" 
            style={{flexGrow: 1, opacity: isScoring ? 0.6 : 1, cursor: isScoring ? 'not-allowed' : 'pointer'}} 
            onClick={() => !isScoring && scoreJob(job.id)}
            disabled={isScoring}
          >
            {isScoring ? '⏳ Thinking...' : '🤖 Analyze Fit'}
          </button>
        )}
        {job.status === 'new' && (
          <>
            <button className="btn save" onClick={() => updateStatus(job.id, 'saved')}>Save</button>
            <button className="btn reject" onClick={() => openSkillModal(job, 'reject')}>Reject</button>
          </>
        )}
        {job.status === 'saved' && (
          <>
            <button 
              className="btn apply obsidian" 
              title="Review buzzwords, export to Obsidian and mark Applied" 
              onClick={() => openSkillModal(job, 'apply')}
              disabled={exportingJobs.has(job.id)}
            >
              {exportingJobs.has(job.id) ? '⏳ Exporting...' : '📝 Apply & Export'}
            </button>
            <button className="btn reject" onClick={() => openSkillModal(job, 'reject')}>Reject</button>
          </>
        )}
        {job.status === 'applied' && (
          <>
            <button 
              className="btn obsidian" 
              title="Open or update note in Obsidian" 
              onClick={() => exportToObsidian(job.id)}
              disabled={exportingJobs.has(job.id)}
            >
              📂 Open in Obsidian
            </button>
            <button className="btn reject" onClick={() => updateStatus(job.id, 'rejected')}>Archive</button>
          </>
        )}
      </div>
    </div>
  )};

  const refreshRescoreStatus = async (): Promise<RescoreStatus | null> => {
    try {
      const status: RescoreStatus = await (await fetch('/api/profile/rescore')).json();
      setRescore(status);
      return status;
    } catch (e) {
      console.error(e);
      return null;
    }
  };

  const startRescore = async () => {
    setRescoreMsg('');
    try {
      const res = await fetch('/api/profile/rescore', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRescoreMsg(typeof data.detail === 'string' ? data.detail : 'Could not start the re-score.');
      }
    } catch (e) {
      console.error(e);
      setRescoreMsg('Could not reach the backend.');
    }
    refreshRescoreStatus(); // the progress itself arrives on the live stream
  };

  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const activeFilterCount = getActiveFilterCount();
  const savedJobs = getFilteredJobs('saved');
  const appliedJobs = getFilteredJobs('applied');
  const totalFilteredJobs = savedJobs.length + appliedJobs.length;
  // The jobs a column can show at all. Counts in the filter panel are against these, not against every job in the
  // database (rejected and viewed-only jobs have no column).
  const boardJobs = jobs.filter(j => j.status === 'saved' || j.status === 'applied');

  return (
    <div className="dashboard">
      <header>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: '1rem'}}>
            <h1 style={{margin: 0}}>Job Hunter OS</h1>
            <input 
              type="text"
              className="header-search"
              placeholder="🔍 Quick search..."
              value={filters.searchQuery}
              onChange={(e) => setFilters(prev => ({ ...prev, searchQuery: e.target.value }))}
            />
          </div>
          <div style={{display: 'flex', gap: '0.75rem', alignItems: 'center'}}>
            <button className="btn outline" style={{color: 'white', borderColor: 'white'}} onClick={() => setShowSettings(!showSettings)}>
              {showSettings ? 'Close Settings' : 'Settings'}
            </button>
          </div>
        </div>

        {progress.isRunning && (
          <div style={{
            marginTop: '1rem',
            background: 'rgba(255, 255, 255, 0.12)',
            borderRadius: '6px',
            padding: '0.75rem 1rem',
            border: '1px solid rgba(255, 255, 255, 0.2)'
          }}>
            <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem', fontSize: '0.9rem'}}>
              <span>
                Re-scoring saved jobs: <strong>{progress.currentJob || 'Starting next job...'}</strong>
              </span>
              <span>
                <strong>{progress.completed}</strong> / {progress.total} ({percent}%)
                {!!progress.failed && <span> · {progress.failed} failed</span>}
              </span>
            </div>
            <div style={{
              width: '100%',
              height: '8px',
              backgroundColor: 'rgba(0, 0, 0, 0.25)',
              borderRadius: '4px',
              overflow: 'hidden'
            }}>
              <div style={{
                width: `${percent}%`,
                height: '100%',
                backgroundColor: '#36b37e',
                borderRadius: '4px',
                transition: 'width 0.4s ease'
              }} />
            </div>
          </div>
        )}
        
        {showSettings && (
          <div className="settings-panel" style={{display: 'flex', gap: '2rem', padding: '1rem', background: '#f4f5f7', color: '#172b4d', marginTop: '1rem', borderRadius: '4px'}}>
            <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: '1.5rem'}}>
              
              <div>
                <h3>AI Configuration</h3>
                <p style={{fontSize: '0.85rem', marginBottom: '0.5rem'}}>Keys are stored safely in your local SQLite DB.</p>
                <div style={{display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
                  <select 
                    value={settings.llm_provider || 'gemini'} 
                    onChange={(e) => updateSetting('llm_provider', e.target.value)}
                    style={{padding: '0.3rem', borderRadius: '4px', border: '1px solid #dfe1e6'}}
                  >
                    <option value="gemini">Google Gemini</option>
                    <option value="openai" disabled>OpenAI (Coming soon)</option>
                    <option value="anthropic" disabled>Anthropic (Coming soon)</option>
                  </select>
                  <select 
                    value={settings.gemini_model || 'gemini-3.5-flash-lite'} 
                    onChange={(e) => updateSetting('gemini_model', e.target.value)}
                    style={{padding: '0.3rem', borderRadius: '4px', border: '1px solid #dfe1e6'}}
                  >
                    <option value="gemini-3.5-flash-lite">Gemini 3.5 Lite (15 RPM / 500 Day)</option>
                    <option value="gemini-3.5-flash">Gemini 3.5 Flash (5 RPM / 20 Day)</option>
                    <option value="gemini-3.1-flash">Gemini 3.1 Flash</option>
                    <option value="gemma-4b">Gemma 4 (30 RPM)</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                  </select>
                  <input 
                    type="password" 
                    value={settings.api_key || ''} 
                    onChange={(e) => setSettings({...settings, api_key: e.target.value})} 
                    onBlur={(e) => updateSetting('api_key', e.target.value)}
                    placeholder="Enter API Key (e.g. AIzaSy...)"
                    style={{padding: '0.3rem', borderRadius: '4px', border: '1px solid #dfe1e6'}}
                  />
                </div>
              </div>

            </div>

            <div style={{flex: 2}}>
              <h3>Profile Documents (For AI Scoring)</h3>
              <p style={{fontSize: '0.85rem', marginBottom: '0.5rem'}}>Paste your CVs, project summaries, or previous cover letters here. The AI will read them to score jobs.</p>
              <ul style={{fontSize: '0.9rem', marginBottom: '0.5rem'}}>
                {documents.map(d => (
                  <li key={d.id}>{d.title} <button style={{border: 'none', background: 'none', cursor: 'pointer', color: 'red'}} onClick={() => deleteDocument(d.id)}>[Delete]</button></li>
                ))}
              </ul>
              <form onSubmit={addDocument} style={{display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
                <input 
                  type="text" 
                  value={newDocTitle} 
                  onChange={(e) => setNewDocTitle(e.target.value)} 
                  placeholder="Document Title (e.g. Main CV, Florent Code League Project)"
                  style={{padding: '0.3rem', borderRadius: '4px', border: '1px solid #dfe1e6'}}
                />
                <textarea 
                  value={newDocContent} 
                  onChange={(e) => setNewDocContent(e.target.value)} 
                  placeholder="Paste the raw text of your CV or project details here..."
                  style={{padding: '0.3rem', borderRadius: '4px', border: '1px solid #dfe1e6', minHeight: '80px', fontFamily: 'monospace'}}
                />
                <button type="submit" className="btn save" style={{padding: '0.3rem 0.6rem', alignSelf: 'flex-start'}}>Add Document</button>
              </form>

              <div style={{marginTop: '1.5rem'}}>
                <h3>Distilled Profile (used for scoring)</h3>
                <p style={{fontSize: '0.85rem', marginBottom: '0.5rem'}}>
                  A short version of the documents above, so each score reads about 500 words instead of the whole CV.
                  Generate a draft, then edit it and state your preferences and dealbreakers. When saved, scoring uses this
                  instead of the full documents. Saving a change marks older scores stale: re-score your saved jobs with the button below, or each one refreshes when you next view its ad.
                </p>
                <p style={{fontSize: '0.85rem', marginBottom: '0.5rem'}}>
                  Scoring with: <strong>{distilled?.scoring_with === 'distilled' ? 'distilled profile' : distilled?.scoring_with === 'raw' ? 'full documents' : 'nothing (add a document first)'}</strong>
                  {distilled?.source_stale && (
                    <span style={{color: '#b45309'}}> — your documents changed after this was saved. Generate a new draft, or save again to keep it as is.</span>
                  )}
                </p>
                <textarea
                  value={distilledText}
                  onChange={(e) => { distilledDirty.current = true; setDistilledText(e.target.value); }}
                  maxLength={distilled?.max_chars}
                  placeholder="No distilled profile yet. Use 'Generate draft' to create one from your documents."
                  style={{padding: '0.3rem', borderRadius: '4px', border: '1px solid #dfe1e6', minHeight: '220px', width: '100%', fontFamily: 'monospace', boxSizing: 'border-box'}}
                />
                <div style={{display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem', flexWrap: 'wrap'}}>
                  <button type="button" className="btn outline" disabled={distilledBusy || documents.length === 0} onClick={generateDistilledDraft} style={{padding: '0.3rem 0.6rem'}}>
                    {distilledBusy ? 'Working...' : 'Generate draft'}
                  </button>
                  <button type="button" className="btn save" disabled={distilledBusy || !distilledText.trim()} onClick={saveDistilled} style={{padding: '0.3rem 0.6rem'}}>Save</button>
                  {distilled?.exists && (
                    <button type="button" className="btn outline" disabled={distilledBusy} onClick={removeDistilled} style={{padding: '0.3rem 0.6rem', color: 'red'}}>Delete</button>
                  )}
                  <span style={{fontSize: '0.8rem', color: '#5e6c84'}}>{distilledText.length} / {distilled?.max_chars ?? 6000}</span>
                </div>
                {distilledMsg && <p style={{fontSize: '0.85rem', marginTop: '0.5rem'}}>{distilledMsg}</p>}
              </div>

              <div style={{marginTop: '1.5rem'}}>
                <h3>Re-score saved jobs</h3>
                {!rescore || rescore.scoring_with === null ? (
                  <p style={{fontSize: '0.85rem'}}>Add a profile document first: scores need a profile to compare jobs against.</p>
                ) : (
                  <>
                    <p style={{fontSize: '0.85rem', marginBottom: '0.5rem'}}>
                      {rescore.to_rescore === 0 && rescore.no_text === 0
                        ? `All ${rescore.saved_total} saved jobs are scored with the current profile.`
                        : `${rescore.saved_total - rescore.current} of ${rescore.saved_total} saved jobs were scored with an older profile, or not at all.`}
                      {' '}Applied, rejected and viewed-only jobs keep their scores.
                    </p>
                    <div style={{display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap'}}>
                      <button
                        type="button"
                        className="btn save"
                        disabled={progress.isRunning || rescore.running || rescore.to_rescore === 0}
                        onClick={startRescore}
                        style={{padding: '0.3rem 0.8rem'}}
                      >
                        {progress.isRunning || rescore.running
                          ? 'Re-scoring…'
                          : `Re-score ${rescore.to_rescore} saved job${rescore.to_rescore === 1 ? '' : 's'}`}
                      </button>
                      {rescore.to_rescore > 0 && !progress.isRunning && (
                        <span style={{fontSize: '0.8rem', color: '#5e6c84'}}>
                          about {Math.max(1, Math.ceil(rescore.estimated_seconds / 60))} min ({rescore.model} allows one call every {rescore.interval_seconds}s)
                        </span>
                      )}
                    </div>
                    {rescore.short_text > 0 && (
                      <p style={{fontSize: '0.8rem', color: '#5e6c84', marginTop: '0.5rem'}}>
                        {rescore.short_text} of these only have a shortened ad text (the old scraper cut ads at 800 characters), so their new score is rougher. Open the ad with the extension to score it from the full text.
                      </p>
                    )}
                    {rescore.no_text > 0 && (
                      <p style={{fontSize: '0.8rem', color: '#5e6c84', marginTop: '0.5rem'}}>
                        {rescore.no_text} stale job{rescore.no_text === 1 ? ' has' : 's have'} no stored ad text and cannot be re-scored here: open {rescore.no_text === 1 ? 'it' : 'them'} with the extension.
                      </p>
                    )}
                  </>
                )}
                {!progress.isRunning && !!progress.failed && (
                  <p style={{fontSize: '0.85rem', marginTop: '0.5rem'}}>
                    The last run could not score {progress.failed} job{progress.failed === 1 ? '' : 's'}; {progress.failed === 1 ? 'it keeps' : 'they keep'} the previous score and can be retried.
                  </p>
                )}
                {!progress.isRunning && progress.stopped && (
                  <p style={{fontSize: '0.85rem', marginTop: '0.5rem', color: '#bf2600'}}>{progress.stopped}</p>
                )}
                {rescoreMsg && <p style={{fontSize: '0.85rem', marginTop: '0.5rem', color: '#bf2600'}}>{rescoreMsg}</p>}
              </div>
            </div>
          </div>
        )}
      </header>
      
      {activeFilterCount > 0 && (
        <div className="active-filters-bar">
          <span style={{fontWeight: 600, fontSize: '0.8rem', color: '#5e6c84'}}>Active Filters:</span>
          {filters.sortBy !== 'newest' && (
            <span className="filter-chip">
              Sort: {getSortLabel(filters.sortBy)}
              <button onClick={() => setFilters(prev => ({ ...prev, sortBy: 'newest' }))}>×</button>
            </span>
          )}
          {filters.searchQuery.trim() !== '' && (
            <span className="filter-chip">
              Search: "{filters.searchQuery}"
              <button onClick={() => setFilters(prev => ({ ...prev, searchQuery: '' }))}>×</button>
            </span>
          )}
          {filters.minScore > 0 && (
            <span className="filter-chip">
              Score ≥ {filters.minScore}
              <button onClick={() => setFilters(prev => ({ ...prev, minScore: 0 }))}>×</button>
            </span>
          )}
          {filters.scoreStatus !== 'all' && (
            <span className="filter-chip">
              {filters.scoreStatus === 'scored_only' ? 'Scored Only' : 'Unscored Only'}
              <button onClick={() => setFilters(prev => ({ ...prev, scoreStatus: 'all' }))}>×</button>
            </span>
          )}
          {filters.source !== 'all' && (
            <span className="filter-chip">
              Source: {filters.source === 'op_kiitorata_2027' ? 'OP Kiitorata 2027' : filters.source}
              <button onClick={() => setFilters(prev => ({ ...prev, source: 'all' }))}>×</button>
            </span>
          )}
          {filters.location.trim() !== '' && (
            <span className="filter-chip">
              Location: {filters.location}
              <button onClick={() => setFilters(prev => ({ ...prev, location: '' }))}>×</button>
            </span>
          )}
          {filters.deadlineOnly && (
            <span className="filter-chip">
              Has Deadline
              <button onClick={() => setFilters(prev => ({ ...prev, deadlineOnly: false }))}>×</button>
            </span>
          )}
          {filters.upcomingOnly && (
            <span className="filter-chip">
              Upcoming Deadlines
              <button onClick={() => setFilters(prev => ({ ...prev, upcomingOnly: false }))}>×</button>
            </span>
          )}
          <button className="clear-all-btn" onClick={resetFilters}>Reset All</button>
        </div>
      )}

      <div className="board">
        <div className="column filter-panel">
          <h2>
            ⚡ Sort &amp; Filter
            {activeFilterCount > 0 && <span className="badge">{activeFilterCount}</span>}
          </h2>

          <div className="filter-group">
            <label htmlFor="filter-sort">Sort by</label>
            <select
              id="filter-sort"
              className="filter-input"
              value={filters.sortBy}
              onChange={(e) => setFilters(prev => ({ ...prev, sortBy: e.target.value as SortOption }))}
            >
              <option value="newest">🆕 Newest Added First</option>
              <option value="score_desc">🌟 Best Fit Score (High to Low)</option>
              <option value="deadline_asc">⏳ Soonest Deadline First</option>
              <option value="deadline_desc">📅 Furthest Deadline First</option>
              <option value="score_asc">📉 Lowest Fit Score</option>
              <option value="company_asc">🏢 Company Name (A to Z)</option>
              <option value="title_asc">🏷️ Job Title (A to Z)</option>
              <option value="oldest">📜 Oldest Added First</option>
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="filter-search">Keyword / text search</label>
            <input
              id="filter-search"
              type="text"
              className="filter-input"
              placeholder="Title, company, skills, reason..."
              value={filters.searchQuery}
              onChange={(e) => setFilters(prev => ({ ...prev, searchQuery: e.target.value }))}
            />
          </div>

          <div className="filter-group">
            <label htmlFor="filter-location">Location</label>
            <input
              id="filter-location"
              type="text"
              className="filter-input"
              placeholder="e.g. Helsinki, Espoo, Remote..."
              value={filters.location}
              onChange={(e) => setFilters(prev => ({ ...prev, location: e.target.value }))}
            />
          </div>

          <div className="filter-group">
            <label htmlFor="filter-minscore">Minimum AI fit score: <strong>{filters.minScore > 0 ? `≥ ${filters.minScore}` : 'any'}</strong></label>
            <input
              id="filter-minscore"
              type="range"
              min="0"
              max="95"
              step="5"
              value={filters.minScore}
              onChange={(e) => setFilters(prev => ({ ...prev, minScore: Number(e.target.value) }))}
              style={{width: '100%', cursor: 'pointer', accentColor: '#0052cc'}}
            />
            <div className="preset-buttons">
              {[[0, 'All'], [50, '50+'], [70, '70+'], [85, '85+']].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`preset-btn ${filters.minScore === value ? 'active' : ''}`}
                  onClick={() => setFilters(prev => ({ ...prev, minScore: value as number }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <label htmlFor="filter-source">Platform / source</label>
            <select
              id="filter-source"
              className="filter-input"
              value={filters.source}
              onChange={(e) => setFilters(prev => ({ ...prev, source: e.target.value as FilterState['source'] }))}
            >
              <option value="all">All sources ({boardJobs.length})</option>
              <option value="op_kiitorata_2027">🚀 OP Kiitorata 2027 ({boardJobs.filter(j => j.source === 'op_kiitorata_2027' || j.url.includes('op-careers.fi')).length})</option>
              <option value="duunitori_auto">Duunitori Auto ({boardJobs.filter(j => j.source === 'duunitori_auto').length})</option>
              <option value="extension">Browser Extension ({boardJobs.filter(j => j.source === 'extension').length})</option>
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="filter-scorestatus">Scoring status</label>
            <select
              id="filter-scorestatus"
              className="filter-input"
              value={filters.scoreStatus}
              onChange={(e) => setFilters(prev => ({ ...prev, scoreStatus: e.target.value as FilterState['scoreStatus'] }))}
            >
              <option value="all">All jobs</option>
              <option value="scored_only">Scored only</option>
              <option value="unscored_only">Unscored only</option>
            </select>
          </div>

          <div className="filter-group">
            <label>Deadlines</label>
            <label className="filter-check">
              <input
                id="filter-deadline-only"
                type="checkbox"
                checked={filters.deadlineOnly}
                onChange={(e) => setFilters(prev => ({ ...prev, deadlineOnly: e.target.checked }))}
              />
              Must have a deadline
            </label>
            <label className="filter-check">
              <input
                id="filter-upcoming-only"
                type="checkbox"
                checked={filters.upcomingOnly}
                onChange={(e) => setFilters(prev => ({ ...prev, upcomingOnly: e.target.checked }))}
              />
              Upcoming only (deadline today or later)
            </label>
          </div>

          <div className="filter-panel-footer">
            <span>Showing <strong>{totalFilteredJobs}</strong> of {boardJobs.length}</span>
            <button
              className="btn outline"
              onClick={resetFilters}
              disabled={activeFilterCount === 0}
              style={{opacity: activeFilterCount === 0 ? 0.5 : 1}}
            >
              Reset
            </button>
          </div>
        </div>
        
        <div className="column">
          <h2>Saved <span className="badge">{savedJobs.length}</span></h2>
          {savedJobs.length === 0 && (
            <p style={{color: '#6b778c', fontSize: '0.85rem', fontStyle: 'italic', textAlign: 'center', marginTop: '1rem'}}>
              No jobs match criteria
            </p>
          )}
          {savedJobs.map(j => <JobCard key={j.id} job={j} />)}
        </div>
        
        <div className="column">
          <h2>Applied <span className="badge">{appliedJobs.length}</span></h2>
          {appliedJobs.length === 0 && (
            <p style={{color: '#6b778c', fontSize: '0.85rem', fontStyle: 'italic', textAlign: 'center', marginTop: '1rem'}}>
              No jobs match criteria
            </p>
          )}
          {appliedJobs.map(j => <JobCard key={j.id} job={j} />)}
        </div>
      </div>

      <SkillReviewModal
        isOpen={reviewModalState.isOpen}
        job={reviewModalState.job}
        action={reviewModalState.action}
        onClose={closeSkillModal}
        onConfirm={handleConfirmReview}
        onSkip={handleSkipReview}
      />
    </div>
  );
}

export default App;
