"""Install Python packages for the Workers runtime."""

from worker import main

raise SystemExit(main(["sync"]))
