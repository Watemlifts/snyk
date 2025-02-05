// # Update Checking Service
//
// Makes a request to Ghost.org to check if there is a new version of Ghost available.
// The service is provided in return for users opting in to anonymous usage data collection.
//
// Blog owners can opt-out of update checks by setting `privacy: { useUpdateCheck: false }` in their config.js
//
// The data collected is as follows:
//
// - blog id - a hash of the blog hostname, pathname and dbHash. No identifiable info is stored.
// - ghost version
// - node version
// - npm version
// - env - production or development
// - database type - SQLite, MySQL, PostgreSQL
// - email transport - mail.options.service, or otherwise mail.transport
// - created date - database creation date
// - post count - total number of posts
// - user count - total number of users
// - theme - name of the currently active theme
// - apps - names of any active apps

const crypto = require('crypto')
const exec = require('child_process').exec
const https = require('https')
const moment = require('moment')
const semver = require('semver')
const Promise = require('bluebird')
const _ = require('lodash')
const url = require('url')

const api = require('./api')
const config = require('./config')
const errors = require('./errors')

const internal = { context: { internal: true } }
const allowedCheckEnvironments = ['development', 'production']
const checkEndpoint = 'updates.ghost.org'
const currentVersion = config.ghostVersion

function updateCheckError (error) {
  api.settings.edit(
    { settings: [{ key: 'nextUpdateCheck', value: Math.round(Date.now() / 1000 + 24 * 3600) }] },
    internal
  ).catch(errors.rejectError)

  errors.logError(
    error,
    'Checking for updates failed, your blog will continue to function.',
    'If you get this error repeatedly, please seek help from https://ghost.org/forum.'
  )
}

function updateCheckData () {
  const data = {}
  const ops = []
  const mailConfig = config.mail

  ops.push(api.settings.read(_.extend({ key: 'dbHash' }, internal)).catch(errors.rejectError))
  ops.push(api.settings.read(_.extend({ key: 'activeTheme' }, internal)).catch(errors.rejectError))
  ops.push(api.settings.read(_.extend({ key: 'activeApps' }, internal))
    .then(function (response) {
      let apps = response.settings[0]
      try {
        apps = JSON.parse(apps.value)
      } catch (e) {
        return errors.rejectError(e)
      }

      return _.reduce(apps, function (memo, item) { return memo === '' ? memo + item : memo + ', ' + item }, '')
    }).catch(errors.rejectError))
  ops.push(api.posts.browse().catch(errors.rejectError))
  ops.push(api.users.browse(internal).catch(errors.rejectError))
  ops.push(Promise.promisify(exec)('npm -v').catch(errors.rejectError))

  data.ghost_version = currentVersion
  data.node_version = process.versions.node
  data.env = process.env.NODE_ENV
  data.database_type = config.database.client
  data.email_transport = mailConfig && (mailConfig.options && mailConfig.options.service ? mailConfig.options.service : mailConfig.transport)

  return Promise.settle(ops).then(function (descriptors) {
    const hash = descriptors[0].value().settings[0]
    const theme = descriptors[1].value().settings[0]
    const apps = descriptors[2].value()
    const posts = descriptors[3].value()
    const users = descriptors[4].value()
    const npm = descriptors[5].value()
    const blogUrl = url.parse(config.url)
    const blogId = blogUrl.hostname + blogUrl.pathname.replace(/\//, '') + hash.value

    data.blog_id = crypto.createHash('sha256').update(blogId).digest('hex')
    data.theme = theme ? theme.value : ''
    data.apps = apps || ''
    data.post_count = posts && posts.meta && posts.meta.pagination ? posts.meta.pagination.total : 0
    data.user_count = users && users.users && users.users.length ? users.users.length : 0
    data.blog_created_at = users && users.users && users.users[0] && users.users[0].created_at ? moment(users.users[0].created_at).unix() : ''
    data.npm_version = _.isArray(npm) && npm[0] ? npm[0].toString().replace(/\n/, '') : ''

    return data
  }).catch(updateCheckError)
}

function updateCheckRequest () {
  return updateCheckData().then(function then (reqData) {
    let resData = ''
    let headers
    let req

    reqData = JSON.stringify(reqData)

    headers = {
      'Content-Length': reqData.length
    }

    return new Promise(function p (resolve, reject) {
      req = https.request({
        hostname: checkEndpoint,
        method: 'POST',
        headers
      }, function handler (res) {
        res.on('error', function onError (error) { reject(error) })
        res.on('data', function onData (chunk) { resData += chunk })
        res.on('end', function onEnd () {
          try {
            resData = JSON.parse(resData)
            resolve(resData)
          } catch (e) {
            reject('Unable to decode update response')
          }
        })
      })

      req.on('socket', function onSocket (socket) {
        // Wait a maximum of 10seconds
        socket.setTimeout(10000)
        socket.on('timeout', function onTimeout () {
          req.abort()
        })
      })

      req.on('error', function onError (error) {
        reject(error)
      })

      req.write(reqData)
      req.end()
    })
  })
}

// ## Update Check Response
// Handles the response from the update check
// Does two things with the information received:
// 1. Updates the time we can next make a check
// 2. Checks if the version in the response is new, and updates the notification setting
function updateCheckResponse (response) {
  const ops = []

  ops.push(
    api.settings.edit(
      { settings: [{ key: 'nextUpdateCheck', value: response.next_check }] },
      internal
    ).catch(errors.rejectError),
    api.settings.edit(
      { settings: [{ key: 'displayUpdateNotification', value: response.version }] },
      internal
    ).catch(errors.rejectError)
  )

  return Promise.settle(ops).then(function then (descriptors) {
    descriptors.forEach(function forEach (d) {
      if (d.isRejected()) {
        errors.rejectError(d.reason())
      }
    })
  })
}

function updateCheck () {
  // The check will not happen if:
  // 1. updateCheck is defined as false in config.js
  // 2. we've already done a check this session
  // 3. we're not in production or development mode
  // TODO: need to remove config.updateCheck in favor of config.privacy.updateCheck in future version (it is now deprecated)
  if (config.updateCheck === false || config.isPrivacyDisabled('useUpdateCheck') || _.indexOf(allowedCheckEnvironments, process.env.NODE_ENV) === -1) {
    // No update check
    return Promise.resolve()
  } else {
    return api.settings.read(_.extend({ key: 'nextUpdateCheck' }, internal)).then(function then (result) {
      const nextUpdateCheck = result.settings[0]

      if (nextUpdateCheck && nextUpdateCheck.value && nextUpdateCheck.value > moment().unix()) {
        // It's not time to check yet

      } else {
        // We need to do a check
        return updateCheckRequest()
          .then(updateCheckResponse)
          .catch(updateCheckError)
      }
    }).catch(updateCheckError)
  }
}

function showUpdateNotification () {
  return api.settings.read(_.extend({ key: 'displayUpdateNotification' }, internal)).then(function then (response) {
    const display = response.settings[0]

    // Version 0.4 used boolean to indicate the need for an update. This special case is
    // translated to the version string.
    // TODO: remove in future version.
    if (display.value === 'false' || display.value === 'true' || display.value === '1' || display.value === '0') {
      display.value = '0.4.0'
    }

    if (display && display.value && currentVersion && semver.gt(display.value, currentVersion)) {
      return display.value
    }

    return false
  })
}

module.exports = updateCheck
module.exports.showUpdateNotification = showUpdateNotification
