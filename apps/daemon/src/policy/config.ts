import { z } from 'zod/v4';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { canonical, hash } from '../core/values.ts';
import { projectPaths } from '../workspaces/git.ts';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const label = z.string().min(1).max(256);
const absolute = z.string().refine(isAbsolute);
const model = z.string().min(1).max(256);
const mainProfileSchema = z.strictObject({
  id: identifier, label, model: model.optional(),
  runtime: z.enum(['antigravity_acp', 'claude_agent_sdk']),
  projects: z.array(identifier).default([]),
  worker_profiles: z.array(identifier).min(1),
  billing: z.enum(['provider_plan', 'api_metered', 'cloud_account', 'unknown']),
}).refine(profile => profile.runtime === 'antigravity_acp' || profile.model !== undefined,
  { path: ['model'], message: 'Claude main profiles require a model.' })
  .transform(profile => ({ ...profile, model: profile.model ?? '' }));
export type MainProfile = z.output<typeof mainProfileSchema>;
const profileSchema = z.strictObject({
  id: identifier, label, model, runtime: z.enum(['codex_app_server', 'claude_agent_sdk']).default('codex_app_server'), mode: z.enum(['read_only', 'workspace_write']),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  network_domains: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/)).max(20).default([]),
  billing: z.enum(['provider_plan', 'api_metered', 'cloud_account', 'unknown']),
  execution_minutes: z.number().int().min(1).max(120).default(30),
  request_minutes: z.number().int().min(1).max(120).default(30),
  total_minutes: z.number().int().min(1).max(360).default(120),
  max_active: z.number().int().min(1).max(2).default(2),
});
export type Profile = z.output<typeof profileSchema>;
const grant = z.strictObject({
  projects: z.array(identifier),
  profiles: z.array(identifier),
  read: z.enum(['own', 'project']).default('project'),
  control: z.enum(['own', 'project']).default('own'),
});
const schema = z.strictObject({
  port: z.number().int().min(1024).max(65535).default(43127),
  codex: absolute,
  codex_home: absolute,
  agy: z.strictObject({ executable: absolute, home: absolute }).optional(),
  claude_sdk: z.strictObject({ home: absolute, authentication: z.enum(['api_key', 'bedrock', 'vertex']) }).optional(),
  main_profiles: z.array(mainProfileSchema).default([]),
  default_worker: identifier.default('sol'),
  projects: z.array(z.strictObject({ id: identifier, label, root: absolute, base_ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/) })).default([]),
  profiles: z.array(profileSchema).min(1),
  clients: z.strictObject({ agy: grant, 'claude-code': grant }),
});
const slots = ['agy', 'claude-code'] as const;
export type Agent = typeof slots[number] | `main:${string}`;
export const isAgent = (value: string): value is Agent => value === 'agy' || value === 'claude-code' || value.startsWith('main:');
export const human = 'console';
export type Client = Agent | typeof human;
export const minCodexVersion = '0.166.0';
export const claudeVersion = '0.3.332';
export const secret = () => randomBytes(32).toString('base64url');

export const within = (root: string, target: string) => {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
};

export class ConfigError extends Error {}

function executable(name: string) {
  for (const directory of (process.env.PATH ?? '').split(':').filter(isAbsolute)) {
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; }
    catch { continue; }
  }
}

function providerHome(field: string, input: string, separateFrom: string[]) {
  let home, info;
  try {
    home = realpathSync(input);
    info = statSync(home);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(`${field} ${JSON.stringify(input)} could not be accessed${code ? ` (${code})` : ''}.`);
  }
  const name = `${field} ${JSON.stringify(home)}`;
  if (!info.isDirectory()) throw new ConfigError(`${name} must be a directory.`);
  if (info.uid !== process.getuid?.()) throw new ConfigError(`${name} must be owned by the current user.`);
  const overlapping = separateFrom.find(path => within(path, home) || within(home, path));
  if (overlapping) throw new ConfigError(`${name} must be separate from ${JSON.stringify(overlapping)}.`);
  if ((info.mode & 0o077) !== 0) {
    const mode = (info.mode & 0o777).toString(8).padStart(4, '0');
    console.warn(`WARN ${name} has mode ${mode}. Group or other users have access.`);
  }
  return home;
}

export function readConfig(state: string) {
  const configPath = join(state, 'config.private.json');
  const stat = statSync(configPath, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
    throw new ConfigError(`${JSON.stringify(configPath)} must be owned by the current user and have mode 0600.`);
  }
  let overrides;
  try { overrides = stat ? JSON.parse(readFileSync(configPath, 'utf8')) : {}; }
  catch { throw new ConfigError('Could not read config.private.json as JSON.'); }
  const codexDefault = join(homedir(), '.codex');
  const agyExecutable = executable('agy');
  const agyHome = join(homedir(), '.zgent-agy');
  const defaults = ['sol', 'astra', 'review'];
  const profilesDefault = [
    { id: 'sol', label: 'Sol', model: 'gpt-6.2-sol', mode: 'workspace_write', effort: 'medium', billing: 'provider_plan' },
    { id: 'astra', label: 'Astra', model: 'gpt-6.2-astra', mode: 'workspace_write', effort: 'high', billing: 'provider_plan' },
    { id: 'review', label: 'Review', model: 'gpt-6.2-astra', mode: 'read_only', billing: 'provider_plan' },
  ];
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new ConfigError('Invalid local configuration. Expected a JSON object.');
  const workerProfiles = Array.isArray(overrides.profiles) ? overrides.profiles.map((item: { id?: string } | null) => item?.id) : defaults;
  const clientDefault = { projects: [], profiles: workerProfiles };
  const personal = !overrides.projects?.length;
  const parsed = schema.safeParse({
    codex: executable('codex') ?? '/usr/local/bin/codex', codex_home: codexDefault,
    ...(personal && agyExecutable ? { agy: { executable: agyExecutable, home: agyHome } } : {}),
    ...(personal ? { main_profiles: [{ id: 'agy-main', label: 'Antigravity', runtime: 'antigravity_acp', worker_profiles: workerProfiles, billing: 'provider_plan' }] } : {}),
    profiles: profilesDefault, clients: { agy: clientDefault, 'claude-code': clientDefault }, ...overrides,
  });
  if (!parsed.success) {
    throw new ConfigError('Invalid local configuration: ' + parsed.error.issues.map(issue => issue.path.join('.')).join(', '));
  }
  const config = parsed.data;
  const codexHome = config.codex_home === codexDefault && !existsSync(codexDefault)
    ? codexDefault : providerHome('codex_home', config.codex_home, [state]);
  const serviceHomes = [codexHome];
  for (const provider of ['agy', 'claude_sdk'] as const) {
    const service = config[provider];
    if (!service) continue;
    if (provider === 'agy' && service.home === agyHome) mkdirSync(agyHome, { mode: 0o700, recursive: true });
    service.home = providerHome(provider + '.home', service.home, [state, ...serviceHomes]);
    serviceHomes.push(service.home);
  }
  const worktreeRoot = join(state, 'worktrees');
  const projects = config.projects.map(project => {
    const paths = projectPaths(project.root);
    if ([paths.root, paths.gitDir].some(path => [state, ...serviceHomes].some(home => within(path, home) || within(home, path)))) {
      throw new Error('Registered projects, daemon state and Codex home must be separate directories.');
    }
    return { ...project, ...paths, worktreeRoot };
  });
  const profiles = config.profiles;
  if (new Set(projects.map(p => p.id)).size !== projects.length || new Set(profiles.map(p => p.id)).size !== profiles.length) {
    throw new Error('Project and profile identifiers must be unique.');
  }
  if (new Set(config.main_profiles.map(item => item.id)).size !== config.main_profiles.length ||
      config.main_profiles.some(item => item.projects.some(id => !projects.some(project => project.id === id)) ||
        item.worker_profiles.some(id => !profiles.some(profile => profile.id === id)))) {
    throw new Error('Main session profiles need unique IDs, registered projects and worker profile grants.');
  }
  for (const client of Object.values(config.clients)) {
    if (client.projects.some(id => !projects.some(project => project.id === id)) ||
        client.profiles.some(id => !profiles.some(profile => profile.id === id))) {
      throw new Error('A client grant references an unregistered project or profile.');
    }
  }
  const authPath = join(state, 'clients.private.json');
  if (!existsSync(authPath)) {
    writeFileSync(authPath, JSON.stringify(Object.fromEntries(slots.map(slot => [slot, secret()]))), { flag: 'wx', mode: 0o600 });
  }
  const credentials = z.strictObject({ agy: z.string().length(43), 'claude-code': z.string().length(43) })
    .parse(JSON.parse(readFileSync(authPath, 'utf8')));
  if (credentials.agy === credentials['claude-code']) throw new Error('MCP clients need separate credentials.');
  chmodSync(authPath, 0o600);
  const origin = 'http://127.0.0.1:' + config.port;
  for (const slot of slots) {
    const url = origin + '/mcp';
    const transport = slot === 'agy' ? { serverUrl: url } : { type: 'http', url };
    const file = join(state, slot + '-mcp.private.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { zgent: { ...transport, headers: { Authorization: 'Bearer ' + credentials[slot] } } } }, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  mkdirSync(worktreeRoot, { mode: 0o700, recursive: true });
  return { ...config, projects, profiles, state, codexHome, origin, credentials, worktreeRoot };
}

export type Config = ReturnType<typeof readConfig>;
export type Project = Config['projects'][number];

export function runtimeIdentity(config: Config, runtime: Profile['runtime'] = 'codex_app_server', previous = false) {
  return hash(canonical({ executable: config.codex, home: config.codexHome, ...(previous ? { version: minCodexVersion } : {}),
    ...(runtime === 'claude_agent_sdk' ? { claude: config.claude_sdk, sdk: claudeVersion } : {}) }));
}

export function revision(profile: Profile, config: Config) {
  const value = canonical({ ...profile, runtimeIdentity: runtimeIdentity(config, profile.runtime) });
  return { value, sha: hash(value) };
}
