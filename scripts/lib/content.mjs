// What this repository deploys to ONE environment: rendered datasources + dashboards with the environment's Zabbix item ids.
//   --env-file <file>  (or PLATFORM_ENV_FILE)   KEY=VALUE environment; default env/lab.env.example (the LAB reference)
//   --item-map <file>  (or ZABBIX_ITEM_MAP_FILE in the env file)   {"<LAB zabbix item id>": "<item id on this Zabbix>"}
import { join } from 'node:path';
import { ROOT, repoDashboards } from './grafana.mjs';
import { loadEnvFile, renderDatasources, loadItemMap, applyItemMap, itemIds } from './envcfg.mjs';

export function loadContext(args) {
  const file = args['env-file'] || process.env.PLATFORM_ENV_FILE || join(ROOT, 'env', 'lab.env.example');
  const env = loadEnvFile(file);
  const itemMap = loadItemMap(args['item-map'] || env.ZABBIX_ITEM_MAP_FILE);
  return { envFile: file, env, envName: env.PLATFORM_ENV || 'lab', itemMap, datasources: renderDatasources(env) };
}

/** [{ file, folderDir, dashboard, state: 'ok' | 'skipped' | 'refused', reason? }]. `dashboard` already carries this environment's item ids. */
export function effectiveDashboards(ctx) {
  return repoDashboards().map(({ file, folderDir, dashboard }) => {
    const usesItems = itemIds(dashboard).length > 0;
    if (!usesItems) return { file, folderDir, dashboard, state: 'ok' };
    if (ctx.itemMap) {
      const r = applyItemMap(dashboard, ctx.itemMap);
      if (r.missing.length) return { file, folderDir, dashboard, state: 'refused', reason: `${r.missing.length} Zabbix item id(s) have no entry in the item map (${r.missing.slice(0, 6).join(', ')}${r.missing.length > 6 ? ', ...' : ''})` };
      return { file, folderDir, dashboard: r.dashboard, state: 'ok' };
    }
    if (ctx.envName === 'lab') return { file, folderDir, dashboard, state: 'ok' };          // LAB: the captured ids ARE the ids
    if (ctx.env.ALLOW_NOC_WITHOUT_ITEM_MAP === 'yes') return { file, folderDir, dashboard, state: 'skipped', reason: 'no Zabbix item map (ALLOW_NOC_WITHOUT_ITEM_MAP=yes)' };
    return { file, folderDir, dashboard, state: 'refused', reason: 'this dashboard addresses Zabbix items by LAB item id and the environment has no item map (see docs/ZABBIX-ITEM-MAP.md)' };
  });
}
