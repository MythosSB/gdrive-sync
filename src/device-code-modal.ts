import { App, Modal, Notice } from "obsidian";

// Ventana que muestra el código y el enlace de Google mientras esperamos.
export class DeviceCodeModal extends Modal {
	cancelled = false;

	constructor(
		app: App,
		private userCode: string,
		private verificationUrl: string
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Conectar con Google" });

		contentEl.createEl("p", {
			text: "1. Abre este enlace en tu navegador e inicia sesión:",
		});
		contentEl.createEl("a", {
			text: this.verificationUrl,
			href: this.verificationUrl,
		});

		contentEl.createEl("p", { text: "2. Escribe este código:" });
		contentEl.createEl("h1", { text: this.userCode });

		const copyButton = contentEl.createEl("button", { text: "Copiar código" });
		copyButton.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(this.userCode);
				new Notice("Código copiado");
			} catch {
				new Notice("No se pudo copiar; escríbelo a mano");
			}
		});

		contentEl.createEl("p", {
			text: "3. Acepta los permisos. Esta ventana se cerrará sola cuando termine.",
		});
	}

	onClose() {
		this.cancelled = true;
		this.contentEl.empty();
	}
}