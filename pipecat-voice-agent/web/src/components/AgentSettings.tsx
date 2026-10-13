import clsx from 'clsx';
import type { AgentSettings as Settings } from '../lib/contracts';
import { fieldClass, Select } from './Field';

export function AgentSettings({
  settings,
  onChange,
  disabled,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  disabled: boolean;
}) {
  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const agent = settings.name.trim() || 'the assistant';
  return (
    <section className="flex flex-col gap-5 p-5 sm:p-6" aria-label="Assistant settings">
      <div>
        <h2 className="text-sm font-semibold">Assistant settings</h2>
        <p className="mt-1 text-sm leading-6 text-stone-600">
          Pick a name and voice, and tell it how to help.
        </p>
      </div>
      <div>
        <label htmlFor="agent-name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="agent-name"
          className={clsx(fieldClass, 'mt-2')}
          value={settings.name}
          maxLength={40}
          disabled={disabled}
          onChange={(event) => update({ name: event.target.value })}
          autoComplete="off"
        />
      </div>
      <div>
        <label htmlFor="agent-voice" className="block text-sm font-medium">
          Voice
        </label>
        <Select
          id="agent-voice"
          className="mt-2"
          value={settings.voice}
          disabled={disabled}
          onChange={(event) => update({ voice: event.target.value as Settings['voice'] })}
        >
          <option value="apollo">Apollo</option>
          <option value="arcas">Arcas</option>
          <option value="asteria">Asteria</option>
          <option value="athena">Athena</option>
          <option value="luna">Luna</option>
          <option value="orion">Orion</option>
          <option value="zeus">Zeus</option>
        </Select>
      </div>
      <div>
        <label htmlFor="agent-instructions" className="block text-sm font-medium">
          Instructions
        </label>
        <textarea
          id="agent-instructions"
          className={clsx(fieldClass, 'mt-2 min-h-28 resize-y')}
          value={settings.instructions}
          maxLength={1600}
          disabled={disabled}
          onChange={(event) => update({ instructions: event.target.value })}
          aria-describedby="instructions-hint"
        />
        <p id="instructions-hint" className="mt-2 text-xs leading-5 text-stone-500">
          A role, a tone, or a task for this conversation.
        </p>
      </div>
      <div className="border-t border-stone-200 pt-5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 accent-orange-700"
            checked={settings.tools_enabled}
            disabled={disabled}
            onChange={(event) => update({ tools_enabled: event.target.checked })}
          />
          <span>
            <span className="font-medium">Tools</span>
            <span className="mt-1 block leading-6 text-stone-600">
              Lets {agent} check the time, weather forecasts, and Cloudflare status, search the web,
              and look up Cloudflare docs. Weather data by{' '}
              <a
                href="https://open-meteo.com/"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-stone-400 underline-offset-2 hover:text-stone-900"
              >
                Open-Meteo
              </a>
              .
            </span>
          </span>
        </label>
      </div>
      {disabled && (
        <p className="text-xs leading-5 text-stone-500">Settings can be changed after this call.</p>
      )}
    </section>
  );
}
