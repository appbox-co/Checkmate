import { IMaintenanceWindowsRepository } from "@/domain/maintenance-windows/maintenance-window.repository.interface.js";
import { isWindowActive } from "@/utils/maintenanceWindow.js";
import { MonitorStatusResponse } from "@/types/network.js";
import { MonitorEvaluation } from "@/worker/worker.interface.js";
import { Check } from "@/domain/checks/check.type.js";
import { Monitor } from "@/domain/monitors/monitor.type.js";
import { IMonitorStatusPolicy } from "@/worker/worker.monitor-status-policy.js";
import { IStatusService } from "@/service/statusService.js";

export interface ICheckEvaluator {
	evaluate(status: MonitorStatusResponse, check: Check, monitor: Monitor): Promise<MonitorEvaluation>;
}

export class CheckEvaluator implements ICheckEvaluator {
	constructor(
		private statusService: IStatusService,
		private monitorStatusPolicy: IMonitorStatusPolicy,
		private maintenanceWindowsRepository?: IMaintenanceWindowsRepository
	) {}
	evaluate = async (status: MonitorStatusResponse, check: Check, monitor: Monitor) => {
		// ****************************
		// Step 3:  Evaluate and return result to reactors
		// ****************************
		if (check.geoCheck || monitor.geoCheckEnabled || monitor.geoCheckLocalStatus) {
			const windows = (await this.maintenanceWindowsRepository?.findByMonitorId(monitor.id, monitor.teamId)) ?? [];
			if (monitor.isActive === false || monitor.status === "paused" || windows.some((window) => isWindowActive(window, new Date()))) {
				const statusChange = {
					monitor,
					statusChanged: false,
					prevStatus: monitor.status,
					code: status.code,
					timestamp: Date.now(),
					geoCheckSkipped: true,
				};
				return { monitor, status, check, statusChange, decision: this.monitorStatusPolicy.evaluate(statusChange) };
			}
		}
		const statusChangeResult = await this.statusService.updateMonitorStatus(status, check, monitor);
		if (statusChangeResult.recoveredGeoFailures?.length) status = { ...status, recoveredGeoFailures: statusChangeResult.recoveredGeoFailures };

		// Step 5.  Get decisions and create an evaluation obj
		const decision = this.monitorStatusPolicy.evaluate(statusChangeResult);
		const evaluation: MonitorEvaluation = {
			monitor: statusChangeResult.monitor,
			status,
			check,
			statusChange: statusChangeResult,
			decision,
		};
		return evaluation;
	};
}
