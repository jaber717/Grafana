// Deterministic Huawei / Cisco fixtures reflecting the HISTORICAL production troubleshooting (synthetic: no production access was used).
//   CPU    walk[1.3.6.1.4.1.2011.6.3.4.1.2] (hwCpuDevDuty): ...6.3.4.1.2.1.0.0 = INTEGER: 6          -> item "Huawei: Custom CPU" = 6 %
//   Memory walk[1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7]: first instance ...16777216 = 0 (WRONG), ...16777217 = 28 (right; CLI showed ~29 %)
// Zabbix does the SNMP walk and preprocessing; Grafana only reads the processed numeric item. The preprocessing regex below is applied here only
// to prove the fixture (28, not 0, not the instance index 29).
export const WALK_CPU = '.1.3.6.1.4.1.2011.6.3.4.1.2.1.0.0 = INTEGER: 6';
export const WALK_MEM = ['.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7.16777216 = INTEGER: 0', '.1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7.16777217 = INTEGER: 28'].join('\n');
export const CLI_MEMORY_PERCENT = 29;
export const MEM_PREPROCESSING_REGEX = String.raw`(?m)^\.?1\.3\.6\.1\.4\.1\.2011\.5\.25\.31\.1\.1\.1\.1\.7\.16777217\s*=\s*INTEGER:\s*(\d+)`;
export const preprocess = (text, zabbixRegex) => { const m = new RegExp(zabbixRegex.replace(/^\(\?m\)/, ''), 'm').exec(text); return m ? Number(m[1]) : null; };

// item lists per device (name, key, value) as the Zabbix item discovery would return them
export const DEVICES = {
  'HW-EDGE-01': [
    { name: 'Huawei: Custom CPU', key: 'huawei.cpu.usage', value: 6 },
    { name: 'Huawei - Custom Memory', key: 'huawei.memory.usage', value: 28 },
    { name: 'Huawei - Memory Raw', key: 'huawei.memory.raw', value: 0 },        // raw / wrong instance: must never be used
    { name: 'ICMP ping', key: 'icmpping', value: 1 },
  ],
  'HW-EDGE-02': [{ name: 'Huawei CPU utilization (hwCpuDevDuty)', key: 'huawei.cpu.util', value: 7 }, { name: 'Huawei Memory utilization', key: 'huawei.memory.util', value: 30 }, { name: 'ICMP ping', key: 'icmpping', value: 1 }],
  'HW-BOTH-03': [{ name: 'Huawei: Custom CPU', key: 'huawei.cpu.usage', value: 6 }, { name: 'CPU utilization', key: 'system.cpu.util', value: 0 }, { name: 'Huawei - Custom Memory', key: 'huawei.memory.usage', value: 28 }, { name: 'Memory utilization', key: 'vm.memory.util', value: 0 }],
  'CISCO-R1': [{ name: '#1: CPU utilization', key: 'system.cpu.util[cpmCPUTotal5minRev.1]', value: 41 }, { name: 'Processor: Memory utilization', key: 'vm.memory.util[vm.memory.util.1]', value: 55 }, { name: 'I/O: Memory utilization', key: 'vm.memory.util[vm.memory.util.2]', value: 50 }],
  'FORTI-FW': [{ name: 'CPU utilization', key: 'system.cpu.util[fgSysCpuUsage.0]', value: 12 }, { name: 'Memory utilization', key: 'vm.memory.util[memoryUsedPercentage.0]', value: 33 }],
  'NO-METRICS-SW': [{ name: 'ICMP ping', key: 'icmpping', value: 1 }, { name: 'Huawei - Memory Raw', key: 'huawei.memory.raw', value: 123456 }],
};
