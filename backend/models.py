from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
import datetime
from database import Base

class Job(Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    company = Column(String, index=True)
    location = Column(String, nullable=True)
    published = Column(String, nullable=True)
    deadline = Column(String, nullable=True)
    description_snippet = Column(Text, nullable=True)
    url = Column(String, unique=True, index=True)
    source = Column(String, default="extension")

    # Capture details
    salary = Column(String, nullable=True)
    job_type = Column(String, nullable=True)
    industry = Column(String, nullable=True)
    apply_url = Column(String, nullable=True)
    fingerprint = Column(String, nullable=True, index=True)  # title+company+location identity, see ingest.py
    raw_payload = Column(Text, nullable=True)  # JSON of the untouched capture
    first_seen_at = Column(DateTime, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)

    # Tracking
    status = Column(String, default="new") # options: new, saved, rejected, applied
    
    # AI Scoring
    fit_score = Column(Integer, nullable=True)
    fit_reason = Column(Text, nullable=True)
    
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Relationships
    job_skills = relationship("JobSkill", back_populates="job", cascade="all, delete-orphan")

class JobUrl(Base):
    """Extra URLs that resolve to a job, e.g. reposts merged into it. Lets ingest() recognise them."""
    __tablename__ = "job_urls"

    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    url = Column(String, unique=True, index=True)

class Skill(Base):
    __tablename__ = "skills"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True)
    canonical_name = Column(String, nullable=True, index=True)
    category = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    job_skills = relationship("JobSkill", back_populates="skill", cascade="all, delete-orphan")

class JobSkill(Base):
    __tablename__ = "job_skills"

    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    skill_id = Column(Integer, ForeignKey("skills.id", ondelete="CASCADE"), index=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("job_id", "skill_id", name="uq_job_skill"),
    )

    job = relationship("Job", back_populates="job_skills")
    skill = relationship("Skill", back_populates="job_skills")

class Keyword(Base):
    __tablename__ = "keywords"

    id = Column(Integer, primary_key=True, index=True)
    word = Column(String, unique=True, index=True)

class ProfileDocument(Base):
    __tablename__ = "profile_documents"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String)
    content = Column(Text)

class SystemSetting(Base):
    __tablename__ = "system_settings"
    
    key = Column(String, primary_key=True, index=True)
    value = Column(String)
