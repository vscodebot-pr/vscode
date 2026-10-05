/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { EXTENSION_INSTALL_SOURCE_CONTEXT, ExtensionInstallSource, IExtensionGalleryService, IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions, getIdAndVersion } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { EnablementState, IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionsWorkbenchService } from '../common/extensions.js';

let registered = false;

/**
 * Registers the extension install/uninstall/search commands. These commands are used not only by
 * the extensions viewlet but also by chat and other contributions that may run in windows (such as
 * the Agents/sessions window) that do not load the full extensions contribution. Registering them
 * from a dedicated module lets those windows register the commands without pulling in the editor
 * panes and view containers. Safe to call multiple times.
 */
export function registerExtensionsCommands(): void {
	if (registered) {
		return;
	}
	registered = true;

	CommandsRegistry.registerCommand({
		id: 'workbench.extensions.installExtension',
		metadata: {
			description: localize('workbench.extensions.installExtension.description', "Install the given extension"),
			args: [
				{
					name: 'extensionIdOrVSIXUri',
					description: localize('workbench.extensions.installExtension.arg.decription', "Extension id or VSIX resource uri"),
					constraint: (value: any) => typeof value === 'string' || value instanceof URI,
				},
				{
					name: 'options',
					description: '(optional) Options for installing the extension. Object with the following properties: ' +
						'`installOnlyNewlyAddedFromExtensionPackVSIX`: When enabled, VS Code installs only newly added extensions from the extension pack VSIX. This option is considered only when installing VSIX. ',
					isOptional: true,
					schema: {
						'type': 'object',
						'properties': {
							'installOnlyNewlyAddedFromExtensionPackVSIX': {
								'type': 'boolean',
								'description': localize('workbench.extensions.installExtension.option.installOnlyNewlyAddedFromExtensionPackVSIX', "When enabled, VS Code installs only newly added extensions from the extension pack VSIX. This option is considered only while installing a VSIX."),
								default: false
							},
							'installPreReleaseVersion': {
								'type': 'boolean',
								'description': localize('workbench.extensions.installExtension.option.installPreReleaseVersion', "When enabled, VS Code installs the pre-release version of the extension if available."),
								default: false
							},
							'donotSync': {
								'type': 'boolean',
								'description': localize('workbench.extensions.installExtension.option.donotSync', "When enabled, VS Code do not sync this extension when Settings Sync is on."),
								default: false
							},
							'justification': {
								'type': ['string', 'object'],
								'description': localize('workbench.extensions.installExtension.option.justification', "Justification for installing the extension. This is a string or an object that can be used to pass any information to the installation handlers. i.e. `{reason: 'This extension wants to open a URI', action: 'Open URI'}` will show a message box with the reason and action upon install."),
							},
							'enable': {
								'type': 'boolean',
								'description': localize('workbench.extensions.installExtension.option.enable', "When enabled, the extension will be enabled if it is installed but disabled. If the extension is already enabled, this has no effect."),
								default: false
							}
						}
					}
				}
			]
		},
		handler: async (
			accessor,
			arg: string | UriComponents,
			options?: {
				installOnlyNewlyAddedFromExtensionPackVSIX?: boolean;
				installPreReleaseVersion?: boolean;
				donotSync?: boolean;
				justification?: string | { reason: string; action: string };
				enable?: boolean;
			}) => {
			const extensionsWorkbenchService = accessor.get(IExtensionsWorkbenchService);
			const extensionManagementService = accessor.get(IWorkbenchExtensionManagementService);
			const extensionGalleryService = accessor.get(IExtensionGalleryService);
			try {
				if (typeof arg === 'string') {
					const [id, version] = getIdAndVersion(arg);
					const extension = extensionsWorkbenchService.local.find(e => areSameExtensions(e.identifier, { id, uuid: version }));
					if (extension?.enablementState === EnablementState.DisabledByExtensionKind) {
						const [gallery] = await extensionGalleryService.getExtensions([{ id, preRelease: options?.installPreReleaseVersion }], CancellationToken.None);
						if (!gallery) {
							throw new Error(localize('notFound', "Extension '{0}' not found.", arg));
						}
						await extensionManagementService.installFromGallery(gallery, {
							isMachineScoped: options?.donotSync ? true : undefined, /* do not allow syncing extensions automatically while installing through the command */
							installPreReleaseVersion: options?.installPreReleaseVersion,
							installGivenVersion: !!version,
							context: { [EXTENSION_INSTALL_SOURCE_CONTEXT]: ExtensionInstallSource.COMMAND },
						});
					} else {
						await extensionsWorkbenchService.install(id, {
							version,
							installPreReleaseVersion: options?.installPreReleaseVersion,
							context: { [EXTENSION_INSTALL_SOURCE_CONTEXT]: ExtensionInstallSource.COMMAND },
							justification: options?.justification,
							enable: options?.enable,
							isMachineScoped: options?.donotSync ? true : undefined, /* do not allow syncing extensions automatically while installing through the command */
						}, ProgressLocation.Notification);
					}
				} else {
					const vsix = URI.revive(arg);
					await extensionsWorkbenchService.install(vsix, { installGivenVersion: true });
				}
			} catch (e) {
				onUnexpectedError(e);
				throw e;
			}
		}
	});

	CommandsRegistry.registerCommand({
		id: 'workbench.extensions.uninstallExtension',
		metadata: {
			description: localize('workbench.extensions.uninstallExtension.description', "Uninstall the given extension"),
			args: [
				{
					name: localize('workbench.extensions.uninstallExtension.arg.name', "Id of the extension to uninstall"),
					schema: {
						'type': 'string'
					}
				}
			]
		},
		handler: async (accessor, id: string) => {
			if (!id) {
				throw new Error(localize('id required', "Extension id required."));
			}
			const extensionManagementService = accessor.get(IExtensionManagementService);
			const installed = await extensionManagementService.getInstalled();
			const [extensionToUninstall] = installed.filter(e => areSameExtensions(e.identifier, { id }));
			if (!extensionToUninstall) {
				throw new Error(localize('notInstalled', "Extension '{0}' is not installed. Make sure you use the full extension ID, including the publisher, e.g.: ms-dotnettools.csharp.", id));
			}
			if (extensionToUninstall.isBuiltin) {
				throw new Error(localize('builtin', "Extension '{0}' is a Built-in extension and cannot be uninstalled", id));
			}

			try {
				await extensionManagementService.uninstall(extensionToUninstall);
			} catch (e) {
				onUnexpectedError(e);
				throw e;
			}
		}
	});

	CommandsRegistry.registerCommand({
		id: 'workbench.extensions.search',
		metadata: {
			description: localize('workbench.extensions.search.description', "Search for a specific extension"),
			args: [
				{
					name: localize('workbench.extensions.search.arg.name', "Query to use in search"),
					schema: { 'type': 'string' }
				}
			]
		},
		handler: async (accessor, query: string = '') => {
			return accessor.get(IExtensionsWorkbenchService).openSearch(query);
		}
	});
}
