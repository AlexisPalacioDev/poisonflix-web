"""Make `import server` work regardless of the current working directory.

The worker is a single flat module (infra/music-worker/server.py), not a
package, so tests need the module's own directory on sys.path before the
first `import server`. Every test module does `from tests._pathsetup import
server` (or imports this first) instead of duplicating the sys.path dance.
"""

import os
import sys

_WORKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

import server  # noqa: E402  (must follow the sys.path fix-up above)
