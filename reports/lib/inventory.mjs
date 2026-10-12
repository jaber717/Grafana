// Device inventory for report scopes, read from Zabbix THROUGH Grafana (the Zabbix datasource's own API pass-through), so the report job
// needs nothing but its read-only Grafana token. Read-only: host.get only. Devices are identified by their Zabbix visible name.
//   host group "Site/<NAME>"  -> site        host group "Type/<NAME>" -> device type
import { SITE_PREFIX, TYPE_PREFIX } from './scope.mjs';

export const ZABBIX_DS_UID = 'zabbix-lab';

export function parseHosts(result) {
  return (result || []).filter((h) => String(h.status ?? '0') === '0').map((h) => {
    const groups = (h.hostgroups || h.groups || []).map((g) => g.name);
    return {
      host: h.name || h.host, technical: h.host, id: h.hostid,
      sites: groups.filter((g) => g.startsWith(SITE_PREFIX)).map((g) => g.slice(SITE_PREFIX.length)),
      types: groups.filter((g) => g.startsWith(TYPE_PREFIX)).map((g) => g.slice(TYPE_PREFIX.length)),
    };
  }).sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

export async function fetchInventory(g, { dsUid = ZABBIX_DS_UID } = {}) {
  const r = await g.json('POST', `/api/datasources/uid/${encodeURIComponent(dsUid)}/resources/zabbix-api`, {
    datasourceId: 1, method: 'host.get', params: { output: ['hostid', 'host', 'name', 'status'], selectHostGroups: ['name'], monitored_hosts: true },
  });
  if (r?.error) throw Object.assign(new Error(`inventory: Zabbix returned an error: ${r.error.message || JSON.stringify(r.error)}`), { transient: false });
  return parseHosts(r?.result);
}
