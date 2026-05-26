<?php

declare(strict_types=1);

namespace ClearlyIP\MagoLsp;

use Composer\Composer;
use Composer\EventDispatcher\EventSubscriberInterface;
use Composer\IO\IOInterface;
use Composer\Plugin\PluginInterface;
use Composer\Script\Event;
use Composer\Script\ScriptEvents;

final class Plugin implements PluginInterface, EventSubscriberInterface
{
    private Composer $composer;
    private IOInterface $io;

    /**
     * Called by Composer when the plugin is first loaded.
     *
     * Stores references to the Composer instance and IO interface so they are
     * available to event handlers later in the same process.
     */
    public function activate(Composer $composer, IOInterface $io): void
    {
        $this->composer = $composer;
        $this->io = $io;
    }

    /**
     * Called by Composer when the plugin is deactivated (e.g. via --no-plugins).
     *
     * No cleanup is required; the binary installed on disk is intentionally
     * left in place so the project continues to function without the plugin.
     */
    public function deactivate(Composer $composer, IOInterface $io): void {}

    /**
     * Called by Composer when the package is removed.
     *
     * Deletes the mago-lsp binary and the version sentinel file from the
     * Composer bin directory so no stale files are left behind.
     */
    public function uninstall(Composer $composer, IOInterface $io): void
    {
        $binDir = (string) $composer->getConfig()->get('bin-dir');
        $ext = PHP_OS_FAMILY === 'Windows' ? '.exe' : '';

        foreach ([Installer::BIN_NAME . $ext, '.mago-lsp-version'] as $file) {
            $path = $binDir . DIRECTORY_SEPARATOR . $file;
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    /**
     * Returns the Composer script events this plugin subscribes to.
     *
     * Both POST_INSTALL_CMD and POST_UPDATE_CMD trigger binary installation so
     * that the correct binary version is present after every `composer install`
     * or `composer update`.
     *
     * @return array<string, string>
     */
    public static function getSubscribedEvents(): array
    {
        return [
            ScriptEvents::POST_INSTALL_CMD => 'onInstall',
            ScriptEvents::POST_UPDATE_CMD  => 'onInstall',
        ];
    }

    /**
     * Entry point for both POST_INSTALL_CMD and POST_UPDATE_CMD events.
     *
     * Delegates to {@see Installer::install()} which handles platform detection,
     * downloading, and extracting the binary.
     */
    public function onInstall(Event $event): void
    {
        (new Installer($event->getIO(), $event->getComposer()))->install();
    }
}
