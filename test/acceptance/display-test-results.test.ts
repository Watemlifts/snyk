import * as tap from 'tap';
import * as sinon from 'sinon';
import * as _ from 'lodash';
import * as fs from 'fs';

// tslint:disable-next-line:no-var-requires
const snykTest = require('../../src/cli/commands/test');
import * as snyk from '../../src/lib';

const {test} = tap;
(tap as any).runOnly = false; // <- for debug. set to true, and replace a test to only(..)

test('`test ruby-app` remediation displayed',  async (t) => {
  chdirWorkspaces();
  const stubbedResponse = JSON.parse(
    fs.readFileSync(__dirname + '/workspaces/ruby-app/test-graph-response-with-remediation.json', 'utf8'),
  );
  const snykTestStub = sinon.stub(snyk, 'test').returns(stubbedResponse);
  try {
    await snykTest('ruby-app');
  } catch (error) {
    const res = error.message;
    t.match(res, 'Upgrade rack@1.6.5 to rack@1.6.11 to fix', 'upgrade advice displayed');
    t.match(res, 'Tested 3 dependencies for known issues, found 6 issues, 8 vulnerable paths.');
  }

  snykTestStub.restore();
  t.end();
});

function chdirWorkspaces(subdir = '') {
  process.chdir(__dirname + '/workspaces' + (subdir ? '/' + subdir : ''));
}
