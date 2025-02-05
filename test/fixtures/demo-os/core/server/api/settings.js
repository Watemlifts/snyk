// # Settings API
// RESTful API for the Setting resource
const _ = require('lodash')
const dataProvider = require('../models')
const Promise = require('bluebird')
const config = require('../config')
const canThis = require('../permissions').canThis
const errors = require('../errors')
const utils = require('./utils')

const docName = 'settings'
let settings

let updateConfigTheme
let updateSettingsCache
let settingsFilter
let filterPaths
let readSettingsResult
let settingsResult
let canEditAllSettings
let populateDefaultSetting
let hasPopulatedDefaults = false

/**
     * ## Cache
     * Holds cached settings
     * @private
     * @type {{}}
     */
let settingsCache = {}

/**
* ### Updates Config Theme Settings
* Maintains the cache of theme specific variables that are reliant on settings.
* @private
*/
updateConfigTheme = function () {
  config.set({
    theme: {
      title: (settingsCache.title && settingsCache.title.value) || '',
      description: (settingsCache.description && settingsCache.description.value) || '',
      logo: (settingsCache.logo && settingsCache.logo.value) || '',
      cover: (settingsCache.cover && settingsCache.cover.value) || '',
      navigation: (settingsCache.navigation && JSON.parse(settingsCache.navigation.value)) || []
    }
  })
}

/**
 * ### Update Settings Cache
 * Maintain the internal cache of the settings object
 * @public
 * @param {Object} settings
 * @returns {Settings}
 */
updateSettingsCache = function (settings) {
  settings = settings || {}

  if (!_.isEmpty(settings)) {
    _.map(settings, function (setting, key) {
      settingsCache[key] = setting
    })

    updateConfigTheme()

    return Promise.resolve(settingsCache)
  }

  return dataProvider.Settings.findAll()
    .then(function (result) {
      settingsCache = readSettingsResult(result.models)

      updateConfigTheme()

      return settingsCache
    })
}

// ## Helpers

/**
 * ### Settings Filter
 * Filters an object based on a given filter object
 * @private
 * @param {Object} settings
 * @param {String} filter
 * @returns {*}
 */
settingsFilter = function (settings, filter) {
  return _.object(_.filter(_.pairs(settings), function (setting) {
    if (filter) {
      return _.some(filter.split(','), function (f) {
        return setting[1].type === f
      })
    }
    return true
  }))
}

/**
 * ### Filter Paths
 * Normalizes paths read by require-tree so that the apps and themes modules can use them. Creates an empty
 * array (res), and populates it with useful info about the read packages like name, whether they're active
 * (comparison with the second argument), and if they have a package.json, that, otherwise false
 * @private
 * @param   {object}            paths       as returned by require-tree()
 * @param   {array/string}      active      as read from the settings object
 * @returns {Array}                         of objects with useful info about apps / themes
 */
filterPaths = function (paths, active) {
  const pathKeys = Object.keys(paths)
  const res = []
  let item

  // turn active into an array (so themes and apps can be checked the same)
  if (!Array.isArray(active)) {
    active = [active]
  }

  _.each(pathKeys, function (key) {
    // do not include hidden files or _messages
    if (key.indexOf('.') !== 0 &&
                key !== '_messages' &&
                key !== 'README.md'
    ) {
      item = {
        name: key
      }
      if (Object.prototype.hasOwnProperty.call(paths[key], 'package.json')) {
        item.package = paths[key]['package.json']
      } else {
        item.package = false
      }

      if (_.indexOf(active, key) !== -1) {
        item.active = true
      }
      res.push(item)
    }
  })
  return res
}

/**
 * ### Read Settings Result
 * @private
 * @param {Array} settingsModels
 * @returns {Settings}
 */
readSettingsResult = function (settingsModels) {
  const settings = _.reduce(settingsModels, function (memo, member) {
    if (!Object.prototype.hasOwnProperty.call(memo, member.attributes.key)) {
      memo[member.attributes.key] = member.attributes
    }

    return memo
  }, {})
  const themes = config.paths.availableThemes
  const apps = config.paths.availableApps
  let res

  if (settings.activeTheme && themes) {
    res = filterPaths(themes, settings.activeTheme.value)

    settings.availableThemes = {
      key: 'availableThemes',
      value: res,
      type: 'theme'
    }
  }

  if (settings.activeApps && apps) {
    res = filterPaths(apps, JSON.parse(settings.activeApps.value))

    settings.availableApps = {
      key: 'availableApps',
      value: res,
      type: 'app'
    }
  }

  return settings
}

/**
 * ### Settings Result
 * @private
 * @param {Object} settings
 * @param {String} type
 * @returns {{settings: *}}
 */
settingsResult = function (settings, type) {
  const filteredSettings = _.values(settingsFilter(settings, type))
  const result = {
    settings: filteredSettings,
    meta: {}
  }

  if (type) {
    result.meta.filters = {
      type
    }
  }

  return result
}

/**
 * ### Populate Default Setting
 * @private
 * @param {String} key
 * @returns Promise(Setting)
 */
populateDefaultSetting = function (key) {
  // Call populateDefault and update the settings cache
  return dataProvider.Settings.populateDefault(key).then(function (defaultSetting) {
    // Process the default result and add to settings cache
    const readResult = readSettingsResult([defaultSetting])

    // Add to the settings cache
    return updateSettingsCache(readResult).then(function () {
      // Get the result from the cache with permission checks
    })
  }).catch(function (err) {
    // Pass along NotFoundError
    if (typeof err === errors.NotFoundError) {
      return Promise.reject(err)
    }

    // TODO: Different kind of error?
    return Promise.reject(new errors.NotFoundError('Problem finding setting: ' + key))
  })
}

/**
 * ### Can Edit All Settings
 * Check that this edit request is allowed for all settings requested to be updated
 * @private
 * @param {Object} settingsInfo
 * @returns {*}
 */
canEditAllSettings = function (settingsInfo, options) {
  const checkSettingPermissions = function (setting) {
    if (setting.type === 'core' && !(options.context && options.context.internal)) {
      return Promise.reject(
        new errors.NoPermissionError('Attempted to access core setting from external request')
      )
    }

    return canThis(options.context).edit.setting(setting.key).catch(function () {
      return Promise.reject(new errors.NoPermissionError('You do not have permission to edit settings.'))
    })
  }
  const checks = _.map(settingsInfo, function (settingInfo) {
    const setting = settingsCache[settingInfo.key]

    if (!setting) {
      // Try to populate a default setting if not in the cache
      return populateDefaultSetting(settingInfo.key).then(function (defaultSetting) {
        // Get the result from the cache with permission checks
        return checkSettingPermissions(defaultSetting)
      })
    }

    return checkSettingPermissions(setting)
  })

  return Promise.all(checks)
}

/**
 * ## Settings API Methods
 *
 * **See:** [API Methods](index.js.html#api%20methods)
 */
settings = {

  /**
     * ### Browse
     * @param {Object} options
     * @returns {*}
     */
  browse: function browse (options) {
    // First, check if we have populated the settings from default-settings yet
    if (!hasPopulatedDefaults) {
      return dataProvider.Settings.populateDefaults().then(function () {
        hasPopulatedDefaults = true
        return settings.browse(options)
      })
    }

    options = options || {}

    const result = settingsResult(settingsCache, options.type)

    // If there is no context, return only blog settings
    if (!options.context) {
      return Promise.resolve(_.filter(result.settings, function (setting) { return setting.type === 'blog' }))
    }

    // Otherwise return whatever this context is allowed to browse
    return canThis(options.context).browse.setting().then(function () {
      // Omit core settings unless internal request
      if (!options.context.internal) {
        result.settings = _.filter(result.settings, function (setting) { return setting.type !== 'core' })
      }

      return result
    })
  },

  /**
     * ### Read
     * @param {Object} options
     * @returns {*}
     */
  read: function read (options) {
    if (_.isString(options)) {
      options = { key: options }
    }

    const getSettingsResult = function () {
      const setting = settingsCache[options.key]
      const result = {}

      result[options.key] = setting

      if (setting.type === 'core' && !(options.context && options.context.internal)) {
        return Promise.reject(
          new errors.NoPermissionError('Attempted to access core setting from external request')
        )
      }

      if (setting.type === 'blog') {
        return Promise.resolve(settingsResult(result))
      }

      return canThis(options.context).read.setting(options.key).then(function () {
        return settingsResult(result)
      }, function () {
        return Promise.reject(new errors.NoPermissionError('You do not have permission to read settings.'))
      })
    }

    // If the setting is not already in the cache
    if (!settingsCache[options.key]) {
      // Try to populate the setting from default-settings file
      return populateDefaultSetting(options.key).then(function () {
        // Get the result from the cache with permission checks
        return getSettingsResult()
      })
    }

    // Get the result from the cache with permission checks
    return getSettingsResult()
  },

  /**
     * ### Edit
     * Update properties of a post
     * @param {{settings: }} object Setting or a single string name
     * @param {{id (required), include,...}} options (optional) or a single string value
     * @return {Promise(Setting)} Edited Setting
     */
  edit: function edit (object, options) {
    options = options || {}
    const self = this
    let type

    // Allow shorthand syntax where a single key and value are passed to edit instead of object and options
    if (_.isString(object)) {
      object = { settings: [{ key: object, value: options }] }
    }

    // clean data
    _.each(object.settings, function (setting) {
      if (!_.isString(setting.value)) {
        setting.value = JSON.stringify(setting.value)
      }
    })

    type = _.find(object.settings, function (setting) { return setting.key === 'type' })
    if (_.isObject(type)) {
      type = type.value
    }

    object.settings = _.reject(object.settings, function (setting) {
      return setting.key === 'type' || setting.key === 'availableThemes' || setting.key === 'availableApps'
    })

    return canEditAllSettings(object.settings, options).then(function () {
      return utils.checkObject(object, docName).then(function (checkedData) {
        options.user = self.user
        return dataProvider.Settings.edit(checkedData.settings, options)
      }).then(function (result) {
        const readResult = readSettingsResult(result)

        return updateSettingsCache(readResult).then(function () {
          return settingsResult(readResult, type)
        })
      })
    })
  }
}

module.exports = settings
module.exports.updateSettingsCache = updateSettingsCache
