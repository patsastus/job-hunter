import re
from pathlib import Path


def test_server_command_limits_graceful_shutdown():
    """With the web app open, an unlimited graceful shutdown hangs every code reload and takes the API down
    (found when a merge reloaded the live backend). See the comment in the Dockerfile."""
    dockerfile = (Path(__file__).resolve().parent.parent / "Dockerfile").read_text()
    cmd = re.search(r"^CMD (\[.*\])$", dockerfile, re.MULTILINE).group(1)
    assert '"--reload"' in cmd
    assert '"--timeout-graceful-shutdown"' in cmd
