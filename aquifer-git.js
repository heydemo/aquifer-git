/**
 * @file
 * Git deployment for Aquifer.
 */

/* globals require, Aquifer, AquiferGitConfig, module */

module.exports = (Aquifer, AquiferGitConfig) => {

  'use strict';

  const AquiferGit = () => {};
  const _ = require('lodash');
  const mktemp = require('mktemp');
  const path = require('path');
  const fs = require('fs-extra');

  /**
   * Informs Aquifer of what this deployment script does.
   * @returns {object} details about this deployment script.
   */
  AquiferGit.commands = () => {
    return {
      'deploy-git': {
        description: 'Deploys the site to a remote Git repository.',
        options: {
          remote: {
            name: '-r, --remote <remote>',
            description: 'The repository to deploy to.'
          },
          branch: {
            name: '-b, --branch <branch>',
            description: 'The branch to deploy to.'
          },
          message: {
            name: '-m, --message <message>',
            default: 'Deployment from source repository.',
            description: 'The message to use with the deployment commit.'
          },
          folder: {
            name: '-f, --folder <folder_name>',
            default: false,
            description: 'Subfolder in remote repository that should hold the build.'
          },
          name: {
            name: '-n, --name <name>',
            default: false,
            description: 'Name to use for the deployment commit signature.'
          },
          email: {
            name: '-a, --email <email>',
            default: false,
            description: 'Email to use for the deployment commit signature.'
          },
          debug: {
            name: '-d, --debug',
            default: false,
            description: 'Don\'t delete the temporary aquifer-git-* directory.'
          }
        }
      }
    };
  };

  /**
   * Run when user runs commands within this extension.
   * @param {string} command string representing the name of the command defined in AquiferGit.commands that should run.
   * @param {object} commandOptions options passed from the command.
   * @param {function} callback function that is called when there is an error message to send.
   * @returns {undefined} null.
   */
  AquiferGit.run = (command, commandOptions, callback) => {
    if (command !== 'deploy-git') {
      callback('Invalid command.');
      return;
    }

    let options = {
      deploymentFiles: [],
      excludeLinks: ['sites/default/files'],
      addLinks: [],
      delPatterns: ['*', '!.git']
    };
    let requiredOptions = ['remote', 'branch', 'message'];
    let optionsMissing  = false;
    let build;
    let destPath;
    let run = new Aquifer.api.run(Aquifer);

    // Parse options and make sure they all exist.
    _.assign(options, AquiferGitConfig, commandOptions, (lastValue, nextValue, name) => {
      return nextValue ? nextValue : lastValue;
    });

    requiredOptions.forEach((name) => {
      if (!options[name]) {
        callback('"' + name + '" option is missing. Cannot deploy.');
        optionsMissing = true;
      }
    });

    if (optionsMissing) {
      return;
    }

    // If we have an email without a name, then we cannot create a custom
    // signature and need to bail out.
    if (options.email && !options.name) {
      callback('Name is required for a custom commit signature if the email is provided.');
      return;
    }

    // Create the destination directory and initiate the promise chain.
    mktemp.createDir('aquifer-git-XXXXXXX')

    // Clone the repository.
    .then((destPath_) => {
      Aquifer.console.log('Cloning the repository into ' + destPath_ + '...', 'status');
      destPath = destPath_;
      return run.invoke('git clone ' + options.remote + ' ' + destPath);
    })

    // Checkout or create the specified branch.
    .then(() => {
      return run.invoke('git -C ' + path.join(Aquifer.projectDir, destPath) + ' checkout ' + options.branch)
        .then(() => {
          Aquifer.console.log('Checking out branch: ' + options.branch + '...', 'status');
        })
        .catch(() => {
          Aquifer.console.log('Creating new branch: ' + options.branch + '...', 'status');
          return run.invoke('git -C ' + path.join(Aquifer.projectDir, destPath) + ' checkout -b ' + options.branch);
        });
    })

    // Build the site.
    .then(() => {
      Aquifer.console.log('Building the site...', 'status');

      let buildOptions = {
        symlink: false,
        delPatterns: options.delPatterns,
        excludeLinks: options.excludeLinks,
        addLinks: options.addLinks
      };

      // Calculate build path.
      let buildPath = destPath;

      // If a folder is specified, add it to the build path.
      if (options.folder) {
        buildPath = path.join(buildPath, options.folder);
      }

      // Create instance of build object.
      build = new Aquifer.api.build(Aquifer);
      return build.create(buildPath, buildOptions);
    })

    // Copy over additional deployment files.
    .then(() => {
      Aquifer.console.log('Copying deployment files...', 'status');
      options.deploymentFiles.forEach(function (link) {
        let src = path.join(Aquifer.projectDir, link.src);
        let dest = path.join(destPath, link.dest);
        fs.removeSync(dest);
        fs.copySync(src, dest, {clobber: true});
      });
    })

    // Clear the current index.
    .then(() => {
      Aquifer.console.log('Clearing the index...', 'status');
      fs.removeSync(path.join(Aquifer.projectDir, destPath, '.git/index'));
    })

    // Add all files to the index.
    .then(() => {
      Aquifer.console.log('Adding all files to the index...', 'status');
      return run.invoke('git -C ' + path.join(Aquifer.projectDir, destPath) + ' add -A');
    })

    // Commit changes.
    .then(() => {
      Aquifer.console.log('Committing changes...', 'status');

      let command = 'git -C ' + path.join(Aquifer.projectDir, destPath) + ' commit -m "' + options.message + '"';

      // Add author info to commit if we have it in config options.
      if (options.name) {
        options.email = options.email || '';
        command += ' --author "' + options.name + ' <' + options.email + '>"';
      }

      return run.invoke(command);
    })

    // Push to origin.
    .then(() => {
      Aquifer.console.log('Pushing branch: ' + options.branch + '...', 'status');
      return run.invoke('git -C ' + path.join(Aquifer.projectDir, destPath) + ' push origin ' + options.branch);
    })

    // Remove the destination path.
    .then(() => {
      if (!options.debug) {
        Aquifer.console.log('Removing the ' + destPath + ' directory...', 'status');
        fs.removeSync(destPath);
      }
    })

    // Success!
    .then(() => {
      Aquifer.console.log('The site has been successfully deployed!', 'success');
    })

    // Catch any errors.
    .catch((err) => {
      if (!options.debug) {
        fs.removeSync(destPath);
      }
      callback(err);
    });
  };

  return AquiferGit;
};
