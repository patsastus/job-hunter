import os
import sys
import tempfile

# Must be set before `database` is imported anywhere.
os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/test.db"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
