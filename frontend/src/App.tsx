import { useEffect, useState } from 'react';
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
  currentJob: string;
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

  // Keyword Management State
  const [keywords, setKeywords] = useState<{id: number, word: string}[]>([]);
  const [newKw, setNewKw] = useState("");
  
  // Profile Document State
  const [documents, setDocuments] = useState<{id: number, title: string, content: string}[]>([]);
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocContent, setNewDocContent] = useState("");
  
  // Settings State
  const [settings, setSettings] = useState<Record<string, string>>({});
  
  const [showSettings, setShowSettings] = useState(false);

  const fetchData = async () => {
    try {
      const [jobRes, kwRes, docRes, setRes] = await Promise.all([
        fetch('/api/jobs'),
        fetch('/api/keywords'),
        fetch('/api/documents'),
        fetch('/api/settings')
      ]);
      setJobs(await jobRes.json());
      setKeywords(await kwRes.json());
      setDocuments(await docRes.json());
      setSettings(await setRes.json());
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
          currentJob: ''
        });
        fetchData();
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
  const [showFilterModal, setShowFilterModal] = useState<boolean>(false);

  // Close modal on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showFilterModal) {
        setShowFilterModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showFilterModal]);

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

  const addKeyword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKw.trim()) return;
    try {
      await fetch('/api/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: newKw.trim() })
      });
      setNewKw("");
      fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  const deleteKeyword = async (id: number) => {
    try {
      await fetch(`/api/keywords/${id}`, { method: 'DELETE' });
      fetchData();
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

  const scoreAllJobs = async () => {
    try {
      await fetch('/api/jobs/score-all', { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
  };

  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const activeFilterCount = getActiveFilterCount();
  const inboxJobs = getFilteredJobs('new');
  const savedJobs = getFilteredJobs('saved');
  const appliedJobs = getFilteredJobs('applied');
  const totalFilteredJobs = inboxJobs.length + savedJobs.length + appliedJobs.length;

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
            <button 
              className="btn outline" 
              style={{
                color: 'white', 
                borderColor: activeFilterCount > 0 ? '#ffab00' : 'white',
                background: activeFilterCount > 0 ? 'rgba(255, 171, 0, 0.2)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem'
              }} 
              onClick={() => setShowFilterModal(true)}
            >
              ⚡ Sort & Filter
              {activeFilterCount > 0 && <span className="badge-count">{activeFilterCount}</span>}
            </button>
            <button 
              className="btn outline" 
              style={{
                color: 'white', 
                borderColor: 'white',
                opacity: progress.isRunning ? 0.7 : 1,
                cursor: progress.isRunning ? 'not-allowed' : 'pointer'
              }} 
              disabled={progress.isRunning}
              onClick={scoreAllJobs}
            >
              {progress.isRunning ? '⏳ Scoring in progress...' : '🤖 Score All Inbox'}
            </button>
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
                Evaluating: <strong>{progress.currentJob || 'Starting next job...'}</strong>
              </span>
              <span>
                <strong>{progress.completed}</strong> / {progress.total} ({percent}%)
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

              <div>
                <h3>Scraper Keywords</h3>
                <p style={{fontSize: '0.85rem', marginBottom: '0.5rem'}}>These keywords are used by the auto-scraper.</p>
                <div className="kw-list" style={{display: 'flex', gap: '0.5rem', flexWrap: 'wrap'}}>
                  {keywords.length === 0 && <span style={{fontSize: '0.85rem'}}>Using defaults (developer, python, go, etc.)</span>}
                  {keywords.map(k => (
                    <span key={k.id} className="kw-tag" style={{background: '#dfe1e6', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.85rem'}}>
                      {k.word} <button style={{border: 'none', background: 'none', cursor: 'pointer'}} onClick={() => deleteKeyword(k.id)}>×</button>
                    </span>
                  ))}
                </div>
                <form onSubmit={addKeyword} style={{marginTop: '0.5rem', display: 'flex', gap: '0.5rem'}}>
                  <input 
                    type="text" 
                    value={newKw} 
                    onChange={(e) => setNewKw(e.target.value)} 
                    placeholder="e.g. rust"
                    style={{padding: '0.3rem', borderRadius: '4px', border: '1px solid #dfe1e6', flex: 1}}
                  />
                  <button type="submit" className="btn save" style={{padding: '0.3rem 0.6rem'}}>Add</button>
                </form>
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
        <div className="column">
          <h2>Inbox <span className="badge">{inboxJobs.length}</span></h2>
          {inboxJobs.length === 0 && (
            <p style={{color: '#6b778c', fontSize: '0.85rem', fontStyle: 'italic', textAlign: 'center', marginTop: '1rem'}}>
              No jobs match criteria
            </p>
          )}
          {inboxJobs.map(j => <JobCard key={j.id} job={j} />)}
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

      {showFilterModal && (
        <div className="modal-backdrop" onClick={() => setShowFilterModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{margin: 0, fontSize: '1.2rem'}}>⚡ Sort & Filter Jobs</h2>
              <button 
                onClick={() => setShowFilterModal(false)}
                style={{background: 'none', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: '#6b778c'}}
              >
                ✕
              </button>
            </div>
            
            <div className="modal-body">
              <div className="filter-grid">
                
                {/* 1. Sorting */}
                <div className="filter-group">
                  <label>Sort By</label>
                  <select 
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

                {/* 2. Platform / Source */}
                <div className="filter-group">
                  <label>Platform / Source</label>
                  <select 
                    className="filter-input"
                    value={filters.source}
                    onChange={(e) => setFilters(prev => ({ ...prev, source: e.target.value as any }))}
                  >
                    <option value="all">All Sources ({jobs.length})</option>
                    <option value="op_kiitorata_2027">🚀 OP Kiitorata 2027 ({jobs.filter(j => j.source === 'op_kiitorata_2027' || j.url.includes('op-careers.fi')).length})</option>
                    <option value="duunitori_auto">Duunitori Auto ({jobs.filter(j => j.source === 'duunitori_auto').length})</option>
                    <option value="extension">Browser Extension ({jobs.filter(j => j.source === 'extension').length})</option>
                  </select>
                </div>

                {/* 3. Search Keywords */}
                <div className="filter-group">
                  <label>Keyword / Text Search</label>
                  <input 
                    type="text"
                    className="filter-input"
                    placeholder="Search title, company, skills, reason..."
                    value={filters.searchQuery}
                    onChange={(e) => setFilters(prev => ({ ...prev, searchQuery: e.target.value }))}
                  />
                </div>

                {/* 4. Location */}
                <div className="filter-group">
                  <label>Location</label>
                  <input 
                    type="text"
                    className="filter-input"
                    placeholder="e.g. Helsinki, Espoo, Remote..."
                    value={filters.location}
                    onChange={(e) => setFilters(prev => ({ ...prev, location: e.target.value }))}
                  />
                </div>

                {/* 5. Score Filter & Presets */}
                <div className="filter-group" style={{gridColumn: '1 / -1'}}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                    <label>Minimum AI Fit Score: <strong>{filters.minScore > 0 ? `≥ ${filters.minScore}` : 'Any Score'}</strong></label>
                  </div>
                  <input 
                    type="range"
                    min="0"
                    max="95"
                    step="5"
                    value={filters.minScore}
                    onChange={(e) => setFilters(prev => ({ ...prev, minScore: Number(e.target.value) }))}
                    style={{width: '100%', cursor: 'pointer', accentColor: '#0052cc'}}
                  />
                  <div className="preset-buttons">
                    <button 
                      type="button"
                      className={`preset-btn ${filters.minScore === 0 ? 'active' : ''}`}
                      onClick={() => setFilters(prev => ({ ...prev, minScore: 0 }))}
                    >
                      All (0+)
                    </button>
                    <button 
                      type="button"
                      className={`preset-btn ${filters.minScore === 50 ? 'active' : ''}`}
                      onClick={() => setFilters(prev => ({ ...prev, minScore: 50 }))}
                    >
                      50+ (Decent)
                    </button>
                    <button 
                      type="button"
                      className={`preset-btn ${filters.minScore === 70 ? 'active' : ''}`}
                      onClick={() => setFilters(prev => ({ ...prev, minScore: 70 }))}
                    >
                      70+ (Strong Match)
                    </button>
                    <button 
                      type="button"
                      className={`preset-btn ${filters.minScore === 85 ? 'active' : ''}`}
                      onClick={() => setFilters(prev => ({ ...prev, minScore: 85 }))}
                    >
                      85+ (Top Matches)
                    </button>
                  </div>
                </div>

                {/* 6. Scoring Status */}
                <div className="filter-group">
                  <label>Scoring Status</label>
                  <select 
                    className="filter-input"
                    value={filters.scoreStatus}
                    onChange={(e) => setFilters(prev => ({ ...prev, scoreStatus: e.target.value as any }))}
                  >
                    <option value="all">All Jobs</option>
                    <option value="scored_only">Scored Only</option>
                    <option value="unscored_only">Unscored Only</option>
                  </select>
                </div>

                {/* 7. Deadline options */}
                <div className="filter-group">
                  <label>Deadlines</label>
                  <div style={{display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.2rem'}}>
                    <label style={{display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 'normal', cursor: 'pointer'}}>
                      <input 
                        type="checkbox"
                        checked={filters.deadlineOnly}
                        onChange={(e) => setFilters(prev => ({ ...prev, deadlineOnly: e.target.checked }))}
                      />
                      Must have a deadline specified
                    </label>
                    <label style={{display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 'normal', cursor: 'pointer'}}>
                      <input 
                        type="checkbox"
                        checked={filters.upcomingOnly}
                        onChange={(e) => setFilters(prev => ({ ...prev, upcomingOnly: e.target.checked }))}
                      />
                      Upcoming only (deadline ≥ today)
                    </label>
                  </div>
                </div>

              </div>
            </div>

            <div className="modal-footer">
              <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem'}}>
                <button 
                  className="btn outline"
                  onClick={resetFilters}
                  disabled={activeFilterCount === 0}
                  style={{opacity: activeFilterCount === 0 ? 0.5 : 1}}
                >
                  Reset All Filters
                </button>
                <span style={{fontSize: '0.85rem', color: '#5e6c84'}}>
                  Matching: <strong>{totalFilteredJobs}</strong> of {jobs.length} jobs
                </span>
              </div>
              <button 
                className="btn save" 
                onClick={() => setShowFilterModal(false)}
                style={{minWidth: '90px'}}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

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
