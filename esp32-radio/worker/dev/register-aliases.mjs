import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { aliases } from './aliases.ts';

const roots = Object.entries(aliases).map(([alias, directory]) => [
  `${alias}/`,
  pathToFileURL(`${directory}/`),
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const [prefix, root] of roots) {
      if (specifier.startsWith(prefix)) {
        return nextResolve(new URL(specifier.slice(prefix.length), root).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
