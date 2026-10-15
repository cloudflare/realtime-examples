# Python packages for Workers

Python Workers need compatible WebAssembly packages. A dependency that imports in a native virtual environment can still fail to build or run in Workers. Check a deployed call when adding dependencies or switching Pipecat providers.

## Supported profile

The bundled Pipecat package targets hosted AI services and Flux turn detection. Local VAD, Smart Turn, loudness analysis, and sentence tokenization require dependencies outside this profile. Use hosted services or run those features in a compatible environment.

Installing the stock package or enabling provider extras can pull in unsupported native dependencies. Keep the [compatibility patch](pipecat.patch), [profile builder](../scripts/build_pipecat.py), and dependency locks together when updating Pipecat. `pylock.toml` resolves the Workers runtime; `uv.lock` resolves native development and tests.

The deployment excludes the unused OpenAI SDK, Pillow, and type stubs. The patch defers Pillow imports until image encoding or resizing is used, so an audio-only pipeline can start without it. Remove the relevant [bundle exclusions](../wrangler.jsonc) when adding an OpenAI service or image handling.

## Rebuild Pipecat

Clone [upstream Pipecat](https://github.com/pipecat-ai/pipecat) into a separate directory. It must contain the revision pinned in the builder. From this project's root:

```sh
python3 scripts/build_pipecat.py /path/to/pipecat
uv lock
npm run setup
```

When changing the profile, assign a new package version and update its path in `pyproject.toml` before regenerating the locks. Reusing a version for different wheel contents can leave installations using a cached package. Validate the deployment bundle as well as the native tests.

## Licenses

See [the component notices](NOTICE) and the license files included in each wheel. The example's MIT license does not replace the licenses of vendored code.
