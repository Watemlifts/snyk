// # Themes API
// RESTful API for Themes
const Promise = require('bluebird')
const _ = require('lodash')
const canThis = require('../permissions').canThis
const config = require('../config')
const errors = require('../errors')
const settings = require('./settings')
let themes

/**
 * ## Themes API Methods
 *
 * **See:** [API Methods](index.js.html#api%20methods)
 */
themes = {
  /**
     * ### Browse
     * Get a list of all the available themes
     * @param {{context}} options
     * @returns {Promise(Themes)}
     */
  browse: function browse (options) {
    options = options || {}

    return canThis(options.context).browse.theme().then(function () {
      return Promise.all([
        settings.read({ key: 'activeTheme', context: { internal: true } }),
        config.paths.availableThemes
      ]).then(function (result) {
        const activeTheme = result[0].settings[0].value
        const availableThemes = result[1]
        const themes = []
        const themeKeys = Object.keys(availableThemes)

        _.each(themeKeys, function (key) {
          if (key.indexOf('.') !== 0 &&
                            key !== '_messages' &&
                            key !== 'README.md'
          ) {
            let item = {
              uuid: key
            }

            if (Object.prototype.hasOwnProperty.call(availableThemes[key], 'package.json')) {
              item = _.merge(item, availableThemes[key]['package.json'])
            }

            item.active = item.uuid === activeTheme

            themes.push(item)
          }
        })

        return { themes }
      })
    }, function () {
      return Promise.reject(new errors.NoPermissionError('You do not have permission to browse themes.'))
    })
  },

  /**
     * ### Edit
     * Change the active theme
     * @param {Theme} object
     * @param {{context}} options
     * @returns {Promise(Theme)}
     */
  edit: function edit (object, options) {
    let themeName

    // Check whether the request is properly formatted.
    if (!_.isArray(object.themes)) {
      return Promise.reject({ type: 'BadRequest', message: 'Invalid request.' })
    }

    themeName = object.themes[0].uuid

    return canThis(options.context).edit.theme().then(function () {
      return themes.browse(options).then(function (availableThemes) {
        let theme

        // Check if the theme exists
        theme = _.find(availableThemes.themes, function (currentTheme) {
          return currentTheme.uuid === themeName
        })

        if (!theme) {
          return Promise.reject(new errors.BadRequestError('Theme does not exist.'))
        }

        // Activate the theme
        return settings.edit(
          { settings: [{ key: 'activeTheme', value: themeName }] }, { context: { internal: true } }
        ).then(function () {
          theme.active = true
          return { themes: [theme] }
        })
      })
    }, function () {
      return Promise.reject(new errors.NoPermissionError('You do not have permission to edit themes.'))
    })
  }
}

module.exports = themes
