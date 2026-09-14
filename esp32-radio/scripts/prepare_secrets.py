#!/usr/bin/env python3
"""Initialize device/viewer credentials and refresh the local worker/.dev.vars export."""
import argparse

from credentials import initialize_credentials, sync_worker_secrets
from project import ROOT


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sync", action="store_true", help="Refresh worker/.dev.vars from existing credentials")
    parser.add_argument("--if-present", action="store_true", help="Allow --sync to skip a checkout with no private files")
    args = parser.parse_args(argv)
    if args.if_present and not args.sync:
        parser.error("--if-present requires --sync")
    if args.sync:
        sync_worker_secrets(ROOT, optional=args.if_present)
    else:
        initialize_credentials(ROOT)
        print("Credentials are ready in .credential.env; worker/.dev.vars is a generated export.")


if __name__ == "__main__":
    main()
