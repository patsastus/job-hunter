import React, { useState, useEffect } from 'react';

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

interface SkillReviewModalProps {
  job: Job | null;
  action: 'reject' | 'apply';
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (jobId: number, skills: string[], action: 'reject' | 'apply') => Promise<void>;
  onSkip: (jobId: number, action: 'reject' | 'apply') => Promise<void>;
}

export const SkillReviewModal: React.FC<SkillReviewModalProps> = ({
  job,
  action,
  isOpen,
  onClose,
  onConfirm,
  onSkip
}) => {
  const [skills, setSkills] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [newSkill, setNewSkill] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen || !job) {
      setSkills([]);
      setNewSkill('');
      return;
    }

    let isMounted = true;
    setLoading(true);

    fetch(`/api/jobs/${job.id}/extract-skills`)
      .then(res => res.json())
      .then(data => {
        if (isMounted) {
          setSkills(data.candidate_skills || []);
        }
      })
      .catch(err => {
        console.error('Failed to extract skills:', err);
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, job]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        handleConfirm();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, skills, job, action, submitting, loading]);

  if (!isOpen || !job) return null;

  const removeSkill = (indexToRemove: number) => {
    setSkills(prev => prev.filter((_, idx) => idx !== indexToRemove));
  };

  const handleAddSkill = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = newSkill.trim();
    if (!trimmed) return;
    if (!skills.some(s => s.toLowerCase() === trimmed.toLowerCase())) {
      setSkills(prev => [...prev, trimmed]);
    }
    setNewSkill('');
  };

  const handleConfirm = async () => {
    if (submitting || loading) return;
    setSubmitting(true);
    try {
      await onConfirm(job.id, skills, action);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSkip(job.id, action);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const isReject = action === 'reject';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '580px' }}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>
              {isReject ? '🛑 Reject & Catalog Buzzwords' : '📝 Apply, Export & Catalog Buzzwords'}
            </h2>
            <div style={{ fontSize: '0.85rem', color: '#6b778c', marginTop: '0.2rem' }}>
              {job.company} — {job.title}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: '#6b778c' }}
          >
            ✕
          </button>
        </div>

        <div className="modal-body" style={{ gap: '1rem' }}>
          <div>
            <label style={{ fontWeight: 600, fontSize: '0.9rem', color: '#172b4d', display: 'block', marginBottom: '0.3rem' }}>
              Identified Requirements ({skills.length})
            </label>
            <p style={{ margin: '0 0 0.6rem 0', fontSize: '0.8rem', color: '#6b778c' }}>
              Click any chip to dismiss it. Add anything the AI missed below.
            </p>

            {loading ? (
              <div style={{ padding: '1.5rem', textAlign: 'center', color: '#6b778c', background: '#f4f5f7', borderRadius: '6px' }}>
                ⏳ Extracting technical requirements from posting...
              </div>
            ) : (
              <div className="skill-chips-container">
                {skills.length === 0 ? (
                  <span style={{ color: '#8993a4', fontSize: '0.85rem', padding: '0.3rem' }}>
                    No specific skills detected. Type below to add.
                  </span>
                ) : (
                  skills.map((skill, idx) => (
                    <span key={idx} className="skill-chip" onClick={() => removeSkill(idx)} title="Click to remove">
                      {skill}
                      <span className="remove-chip">✕</span>
                    </span>
                  ))
                )}
              </div>
            )}
          </div>

          <form onSubmit={handleAddSkill} className="skill-input-row">
            <input
              type="text"
              placeholder="Add missing requirement (e.g. Go, Docker, gRPC)..."
              value={newSkill}
              onChange={e => setNewSkill(e.target.value)}
              disabled={loading || submitting}
            />
            <button type="submit" className="btn outline" disabled={!newSkill.trim() || loading || submitting}>
              + Add
            </button>
          </form>
        </div>

        <div className="modal-footer">
          <button className="btn outline" onClick={handleSkip} disabled={submitting}>
            {isReject ? 'Skip & Reject' : 'Skip & Apply'}
          </button>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn outline" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className={`btn ${isReject ? 'reject' : 'apply obsidian'}`}
              onClick={handleConfirm}
              disabled={submitting || loading}
              style={{ minWidth: '150px' }}
            >
              {submitting
                ? 'Saving...'
                : isReject
                ? `Confirm Reject (${skills.length})`
                : `Apply & Export (${skills.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
