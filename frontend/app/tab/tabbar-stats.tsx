// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { waveEventSubscribeSingle } from "@/app/store/wps";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { memo, useEffect, useState } from "react";

dayjs.extend(utc);

type SysInfo = {
    cpu: number | null;
    memPct: number | null;
    load1: number | null;
};

const numCores = navigator.hardwareConcurrency || 4;

function getMetricColor(pct: number | null, warnThreshold: number, errorThreshold: number): string {
    if (pct == null) return "";
    if (pct > errorThreshold) return "text-error";
    if (pct > warnThreshold) return "text-warning";
    return "";
}

function getLoadColor(load1: number | null): string {
    if (load1 == null) return "";
    if (load1 > numCores * 1.2) return "text-error";
    if (load1 > numCores * 0.8) return "text-warning";
    return "";
}

const TabBarStats = memo(() => {
    const [time, setTime] = useState(() => dayjs());
    const [sysInfo, setSysInfo] = useState<SysInfo>({ cpu: null, memPct: null, load1: null });

    useEffect(() => {
        const interval = setInterval(() => setTime(dayjs()), 1000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const unsubFn = waveEventSubscribeSingle({
            eventType: "sysinfo",
            scope: "local",
            handler: (event) => {
                const data = event.data;
                if (data?.values == null) return;
                const cpu = data.values.cpu ?? null;
                const memUsed = data.values["mem:used"];
                const memTotal = data.values["mem:total"];
                const memPct = memUsed != null && memTotal != null && memTotal > 0 ? (memUsed / memTotal) * 100 : null;
                const load1 = data.values["load:1"] ?? null;
                setSysInfo({ cpu, memPct, load1 });
            },
        });
        return unsubFn;
    }, []);

    const localTime = time.format("HH:mm");
    const utcTime = time.utc().format("HH:mm") + "Z";

    const cpuStr = sysInfo.cpu != null ? `CPU: ${Math.round(sysInfo.cpu).toString().padStart(3)}%` : "CPU:  --% ";
    const memStr = sysInfo.memPct != null ? `Mem: ${Math.round(sysInfo.memPct).toString().padStart(3)}%` : "Mem:  --% ";
    const loadStr = sysInfo.load1 != null ? `Ld: ${sysInfo.load1.toFixed(2).padStart(6)}` : "Ld:    -- ";

    const cpuColor = getMetricColor(sysInfo.cpu, 70, 90);
    const memColor = getMetricColor(sysInfo.memPct, 70, 90);
    const loadColor = getLoadColor(sysInfo.load1);

    return (
        <span
            className="px-2 mb-1 text-[12px] font-mono font-bold text-secondary whitespace-nowrap select-none tracking-wide"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
            {localTime}
            {" \u00B7 "}
            {utcTime}
            {" \u00B7 "}
            <span className={`inline-block ${cpuColor}`} style={{ minWidth: "9ch" }}>
                {cpuStr}
            </span>
            {" \u00B7 "}
            <span className={`inline-block ${memColor}`} style={{ minWidth: "9ch" }}>
                {memStr}
            </span>
            {" \u00B7 "}
            <span className={`inline-block ${loadColor}`} style={{ minWidth: "10ch" }}>
                {loadStr}
            </span>
        </span>
    );
});

TabBarStats.displayName = "TabBarStats";

export { TabBarStats };
