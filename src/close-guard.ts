import { App, Modal, Platform, Setting } from "obsidian";
import type GDriveSyncPlugin from "./main";
import type { SyncRunner } from "./sync-runner";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Menú que se muestra al cerrar Obsidian con cambios sin sincronizar.
class CloseModal extends Modal {
	private dismissed = false;

	constructor(
		app: App,
		private syncFn: () => Promise<boolean>,
		private closeNow: () => void,
		private onDismiss: () => void
	) {
		super(app);
	}

	onOpen() {
		this.renderAsk(false);
	}

	private renderAsk(failed: boolean): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", {
			text: failed ? "No se pudo sincronizar" : "Hay cambios sin sincronizar",
		});
		contentEl.createEl("p", {
			text: failed
				? "No se pudieron subir todos los cambios (¿sin conexión?). Puedes cerrar igualmente: " +
					"se sincronizarán la próxima vez que abras Obsidian."
				: "Tienes cambios que todavía no se han subido a Google Drive.",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(failed ? "Reintentar" : "Cerrar y sincronizar")
					.setCta()
					.onClick(() => {
						void this.syncAndClose();
					})
			)
			.addButton((button) =>
				button
					.setButtonText("Cerrar ahora")
					.setWarning()
					.onClick(() => {
						this.close();
						this.closeNow();
					})
			)
			.addButton((button) =>
				button.setButtonText("Cancelar").onClick(() => this.close())
			);
	}

	private async syncAndClose(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Sincronizando..." });
		contentEl.createEl("p", { text: "Obsidian se cerrará al terminar." });

		const ok = await this.syncFn();
		if (this.dismissed) return; // si pulsaste Esc mientras tanto, no cerramos
		if (ok) {
			this.close();
			this.closeNow();
		} else {
			this.renderAsk(true);
		}
	}

	onClose() {
		this.dismissed = true;
		this.contentEl.empty();
		this.onDismiss();
	}
}

// Avisa antes de cerrar Obsidian si quedan cambios sin sincronizar.
export class CloseGuard {
	private allowClose = false;
	private modalOpen = false;

	constructor(private plugin: GDriveSyncPlugin, private runner: SyncRunner) {}

	start(): void {
		// Escritorio: interceptamos el cierre de la ventana.
		const onBeforeUnload = (event: BeforeUnloadEvent) => this.onBeforeUnload(event);
		window.addEventListener("beforeunload", onBeforeUnload);
		this.plugin.register(() =>
			window.removeEventListener("beforeunload", onBeforeUnload)
		);

		// Móvil: no hay "cerrar"; al salir de la app intentamos sincronizar.
		this.plugin.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") this.onHidden();
		});
	}

	private onBeforeUnload(event: BeforeUnloadEvent): void {
		const settings = this.plugin.settings;
		if (this.allowClose || Platform.isMobile) return;
		if (!settings.confirmBeforeClose || !settings.refreshToken) return;
		if (!this.runner.hasPendingChanges && !this.runner.isBusy) return;

		// Cancelamos el cierre y mostramos nuestro menú.
		event.preventDefault();
		event.returnValue = false;
		this.openModal();
	}

	private onHidden(): void {
		const settings = this.plugin.settings;
		if (!Platform.isMobile || !settings.confirmBeforeClose) return;
		if (this.runner.hasPendingChanges && !this.runner.isBusy) {
			void this.runner.run("auto");
		}
	}

	private openModal(): void {
		if (this.modalOpen) return;
		this.modalOpen = true;

		new CloseModal(
			this.plugin.app,
			async () => {
				// Si justo hay una sincronización en curso, la esperamos y luego hacemos otra.
				while (this.runner.isBusy) await sleep(200);
				return this.runner.run("auto");
			},
			() => {
				this.allowClose = true;
				window.close();
			},
			() => {
				this.modalOpen = false;
			}
		).open();
	}
}