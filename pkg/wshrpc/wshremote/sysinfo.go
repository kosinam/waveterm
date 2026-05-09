// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"log"
	"strconv"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const BYTES_PER_GB = 1073741824

func getCpuData(values map[string]float64) {
	percentArr, err := cpu.Percent(0, false)
	if err != nil {
		return
	}
	if len(percentArr) > 0 {
		values[wshrpc.TimeSeries_Cpu] = percentArr[0]
	}
	percentArr, err = cpu.Percent(0, true)
	if err != nil {
		return
	}
	for idx, percent := range percentArr {
		values[wshrpc.TimeSeries_Cpu+":"+strconv.Itoa(idx)] = percent
	}
}

func getMemData(values map[string]float64) {
	memData, err := mem.VirtualMemory()
	if err != nil {
		return
	}
	values["mem:total"] = float64(memData.Total) / BYTES_PER_GB
	values["mem:available"] = float64(memData.Available) / BYTES_PER_GB
	values["mem:used"] = float64(memData.Used) / BYTES_PER_GB
	values["mem:free"] = float64(memData.Free) / BYTES_PER_GB
}

func getDiskData(values map[string]float64) {
	usage, err := disk.Usage("/")
	if err != nil {
		return
	}
	values["disk:pct"] = usage.UsedPercent
}

type netState struct {
	ts   int64
	sent uint64
	recv uint64
}

func getNetData(values map[string]float64, state *netState) {
	counters, err := gnet.IOCounters(false)
	if err != nil || len(counters) == 0 {
		return
	}
	c := counters[0]
	now := time.Now().UnixMilli()
	if state.ts > 0 {
		dt := float64(now-state.ts) / 1000.0
		if dt > 0 {
			values["net:in"] = float64(c.BytesRecv-state.recv) / dt / (1024 * 1024)
			values["net:out"] = float64(c.BytesSent-state.sent) / dt / (1024 * 1024)
		}
	}
	state.ts = now
	state.sent = c.BytesSent
	state.recv = c.BytesRecv
}

func generateSingleServerData(client *wshutil.WshRpc, connName string, netSt *netState) {
	now := time.Now()
	values := make(map[string]float64)
	getCpuData(values)
	getMemData(values)
	getDiskData(values)
	getNetData(values, netSt)
	tsData := wshrpc.TimeSeriesData{Ts: now.UnixMilli(), Values: values}
	event := wps.WaveEvent{
		Event:   wps.Event_SysInfo,
		Scopes:  []string{connName},
		Data:    tsData,
		Persist: 1024,
	}
	wshclient.EventPublishCommand(client, event, &wshrpc.RpcOpts{NoResponse: true})
}

func RunSysInfoLoop(client *wshutil.WshRpc, connName string) {
	defer func() {
		log.Printf("sysinfo loop ended conn:%s\n", connName)
	}()
	netSt := &netState{}
	for {
		generateSingleServerData(client, connName, netSt)
		time.Sleep(1 * time.Second)
	}
}
