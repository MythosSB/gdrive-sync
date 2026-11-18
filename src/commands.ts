import { Notice } from "obsidian";
import type GDriveSyncPlugin from "./main";
import { PlanModal } from "./plan-modal";
import { SyncScheduler } from "./scheduler";
import { SyncRunner } from "./sync-runner";

// Registra los comandos, el icono lateral, la barra de estado y la sincronización automática.
export function registerSyncCommands(plugin: GDriveSyncPlugin): void {
	const runner = new SyncRunner(plugin);

	// Barra de estado (solo se ve en escritorio)
	runner.statusEl = plugin.addStatusBarItem();
	runner.setStatus("listo");

	const scheduler = new SyncScheduler(plugin, runner);
	plugin.scheduler = scheduler;
	scheduler.start();

	plugin.addCommand({
		id: "sync-dry-run",
		name: "Sync: preview changes (dry run)",
		callback: async () => {
			try {
				new Notice("Analizando cambios...");
				const plan = await runner.preview();
				new PlanModal(plugin.app, plan).open();
			} catch (error) {
				console.error(error);
				new Notice(error instanceof Error ? error.message : String(error));
			}
		},
	});

	plugin.addCommand({
		id: "sync-now",
		name: "Sync now",
		callback: () => runner.run("manual"),
	});

	plugin.addRibbonIcon("refresh-cw", "GDrive Sync: sync now", () => {
		void runner.run("manual");
	});
}