/*
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
*/

var optimist = require('optimist');
var apputil = require('./apputil');
var executil = require('./executil');
var flagutil = require('./flagutil');
var gitutil = require('./gitutil');
var repoutil = require('./repoutil');
var print = apputil.print;

module.exports = function*(argv) {
    var opt = flagutil.registerRepoFlag(optimist)
    var opt = opt
        .options('b', {
            alias: 'branch',
            desc: 'The name of the branch to update. Can be specified multiple times to update multiple branches.',
            default: ['master', 'dev']
         })
        .options('fetch', {
            type: 'boolean',
            desc: 'Use --no-fetch to skip the "git fetch" step.',
            default: true
         });
    opt = flagutil.registerHelpFlag(opt);
    var argv = opt
        .usage('Updates git repositories by performing the following commands:\n' +
               '    save active branch\n' +
               '    git fetch $REMOTE \n' +
               '    git stash\n' +
               '    for each specified branch:\n' +
               '        git checkout $BRANCH\n' +
               '        git rebase $REMOTE/$BRANCH\n' +
               '        git checkout -\n' +
               '    git checkout $SAVED_ACTIVE_BRANCH\n' +
               '    git stash pop\n' +
               '\n' +
               'Usage: $0 repo-update')
        .argv;

    if (argv.h) {
        optimist.showHelp();
        process.exit(1);
    }
    var branches = Array.isArray(argv.b) ? argv.b : [argv.b];
    var repos = flagutil.computeReposFromFlag(argv.r);

    // ensure that any missing repos are cloned
    yield require('./repo-clone').cloneRepos(repos,true);
    yield updateRepos(repos, branches, !argv.fetch);
}

function *updateRepos(repos, branches, noFetch) {
    // Pre-fetch checks.
    yield repoutil.forEachRepo(repos, function*(repo) {
        if (repo.svn) {
            return;
        }
        // Ensure it's on a named branch.
        yield gitutil.retrieveCurrentBranchName();
        // Find the apache remote.
        if (!repo.remoteName) {
            repo.remoteName = yield determineApacheRemote(repo);
        }
    });

    if (!noFetch) {
        yield repoutil.forEachRepo(repos, function*(repo) {
            if (repo.svn) {
                return;
            }
            // TODO - can these be combined? Fetching with --tags seems to not pull in changes...
            yield executil.execHelper(executil.ARGS('git fetch --progress ' + repo.remoteName));
            yield executil.execHelper(executil.ARGS('git fetch --progress --tags ' + repo.remoteName));
        });
    }

    if (branches && branches.length) {
        yield repoutil.forEachRepo(repos, function*(repo) {
            if (repo.svn) {
                yield executil.execHelper(executil.ARGS('svn up'));
                return;
            }
            var staleBranches = {};
            for (var i = 0; i < branches.length; ++i) {
                var branchName = branches[i];
                if (yield gitutil.remoteBranchExists(repo, branches[i])) {
                    var changes = yield executil.execHelper(executil.ARGS('git log --oneline ' + branchName + '..' + repo.remoteName + '/' + branchName), true, true);
                    staleBranches[branchName] = !!changes;
                }
            }
            var staleBranches = branches.filter(function(branchName) {
                return !!staleBranches[branchName];
            });
            if (!staleBranches.length) {
                print('Confirmed already up-to-date: ' + repo.repoName);
            } else {
                print('Updating ' + repo.repoName);
                yield gitutil.stashAndPop(repo, function*() {
                    for (var i = 0; i < staleBranches.length; ++i) {
                        var branchName = staleBranches[i];
                        yield gitutil.gitCheckout(branchName);
                        var ret = yield executil.execHelper(executil.ARGS('git rebase ' + repo.remoteName + '/' + branchName), false, true);
                        if (ret === null) {
                            apputil.fatal('\n\nUpdate failed. Run again with --no-fetch to try again without re-fetching.');
                        }
                    }
                });
            }
        });
    }
}
module.exports.updateRepos = updateRepos;

function *determineApacheRemote(repo) {
    var fields = (yield executil.execHelper(executil.ARGS('git remote -v'), true)).split(/\s+/);
    var ret = null;
    for (var i = 1; i < fields.length; i += 3) {
        ['git-wip-us.apache.org/repos/asf/', 'git.apache.org/'].forEach(function(validRepo) {
            if (fields[i].indexOf(validRepo + repo.repoName) != -1) {
                ret = fields[i - 1];
            }
        });
    }
    if (ret)
        return ret;
    apputil.fatal('Could not find an apache remote for repo ' + repo.repoName);
}
