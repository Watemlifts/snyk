const _ = require('lodash')
const Promise = require('bluebird')
const errors = require('../errors')
const utils = require('../utils')
const bcrypt = require('bcryptjs')
const ghostBookshelf = require('./base')
const crypto = require('crypto')
const validator = require('validator')
const request = require('request')
const validation = require('../data/validation')
const config = require('../config')
const events = require('../events')

const bcryptGenSalt = Promise.promisify(bcrypt.genSalt)
const bcryptHash = Promise.promisify(bcrypt.hash)
const bcryptCompare = Promise.promisify(bcrypt.compare)

const tokenSecurity = {}
const activeStates = ['active', 'warn-1', 'warn-2', 'warn-3', 'warn-4', 'locked']
const invitedStates = ['invited', 'invited-pending']
let User
let Users

function validatePasswordLength (password) {
  return validator.isLength(password, 8)
}

function generatePasswordHash (password) {
  // Generate a new salt
  return bcryptGenSalt().then(function (salt) {
    // Hash the provided password with bcrypt
    return bcryptHash(password, salt)
  })
}

User = ghostBookshelf.Model.extend({

  tableName: 'users',

  emitChange: function emitChange (event) {
    events.emit('user' + '.' + event, this)
  },

  initialize: function initialize () {
    ghostBookshelf.Model.prototype.initialize.apply(this, arguments)

    this.on('created', function onCreated (model) {
      model.emitChange('added')

      // active is the default state, so if status isn't provided, this will be an active user
      if (!model.get('status') || _.contains(activeStates, model.get('status'))) {
        model.emitChange('activated')
      }
    })
    this.on('updated', function onUpdated (model) {
      model.statusChanging = model.get('status') !== model.updated('status')
      model.isActive = _.contains(activeStates, model.get('status'))

      if (model.statusChanging) {
        model.emitChange(model.isActive ? 'activated' : 'deactivated')
      } else {
        if (model.isActive) {
          model.emitChange('activated.edited')
        }
      }

      model.emitChange('edited')
    })
    this.on('destroyed', function onDestroyed (model) {
      if (_.contains(activeStates, model.previous('status'))) {
        model.emitChange('deactivated')
      }

      model.emitChange('deleted')
    })
  },

  saving: function saving (newPage, attr, options) {
    /* jshint unused:false */

    const self = this

    ghostBookshelf.Model.prototype.saving.apply(this, arguments)

    if (this.hasChanged('slug') || !this.get('slug')) {
      // Generating a slug requires a db call to look for conflicting slugs
      return ghostBookshelf.Model.generateSlug(User, this.get('slug') || this.get('name'),
        { status: 'all', transacting: options.transacting, shortSlug: !this.get('slug') })
        .then(function then (slug) {
          self.set({ slug })
        })
    }
  },

  // For the user model ONLY it is possible to disable validations.
  // This is used to bypass validation during the credential check, and must never be done with user-provided data
  // Should be removed when #3691 is done
  validate: function validate () {
    const opts = arguments[1]
    if (opts && _.has(opts, 'validate') && opts.validate === false) {
      return
    }
    return validation.validateSchema(this.tableName, this.toJSON())
  },

  // Get the user from the options object
  contextUser: function contextUser (options) {
    // Default to context user
    if (options.context && options.context.user) {
      return options.context.user
      // Other wise use the internal override
    } else if (options.context && options.context.internal) {
      return 1
      // This is the user object, so try using this user's id
    } else if (this.get('id')) {
      return this.get('id')
    } else {
      errors.logAndThrowError(new Error('missing context'))
    }
  },

  toJSON: function toJSON (options) {
    const attrs = ghostBookshelf.Model.prototype.toJSON.call(this, options)
    // remove password hash for security reasons
    delete attrs.password

    if (!options || !options.context || (!options.context.user && !options.context.internal)) {
      delete attrs.email
    }

    return attrs
  },

  format: function format (options) {
    if (!_.isEmpty(options.website) &&
            !validator.isURL(options.website, {
              require_protocol: true,
              protocols: ['http', 'https']
            })) {
      options.website = 'http://' + options.website
    }
    return ghostBookshelf.Model.prototype.format.call(this, options)
  },

  posts: function posts () {
    return this.hasMany('Posts', 'created_by')
  },

  roles: function roles () {
    return this.belongsToMany('Role')
  },

  permissions: function permissions () {
    return this.belongsToMany('Permission')
  },

  hasRole: function hasRole (roleName) {
    const roles = this.related('roles')

    return roles.some(function getRole (role) {
      return role.get('name') === roleName
    })
  }

}, {
  setupFilters: function setupFilters (options) {
    const filterObjects = {}
    // Deliberately switch from singular 'tag' to 'tags' and 'role' to 'roles' here
    // TODO: make this consistent
    if (options.role !== undefined) {
      filterObjects.roles = ghostBookshelf.model('Role').forge({ name: options.role })
    }

    return filterObjects
  },

  findPageDefaultOptions: function findPageDefaultOptions () {
    return {
      status: 'active',
      where: {},
      whereIn: {}
    }
  },

  orderDefaultOptions: function orderDefaultOptions () {
    return {
      last_login: 'DESC',
      name: 'ASC',
      created_at: 'DESC'
    }
  },

  processOptions: function processOptions (itemCollection, options) {
    // TODO: there are multiple statuses that make a user "active" or "invited" - we a way to translate/map them:
    // TODO (cont'd from above): * valid "active" statuses: active, warn-1, warn-2, warn-3, warn-4, locked
    // TODO (cont'd from above): * valid "invited" statuses" invited, invited-pending

    // Filter on the status.  A status of 'all' translates to no filter since we want all statuses
    if (options.status && options.status !== 'all') {
      // make sure that status is valid
      // TODO: need a better way of getting a list of statuses other than hard-coding them...
      options.status = _.indexOf(
        ['active', 'warn-1', 'warn-2', 'warn-3', 'warn-4', 'locked', 'invited', 'inactive'],
        options.status) !== -1
        ? options.status
        : 'active'
    }

    if (options.status === 'active') {
      itemCollection.query().whereIn('status', activeStates)
    } else if (options.status === 'invited') {
      itemCollection.query().whereIn('status', invitedStates)
    } else if (options.status !== 'all') {
      options.where.status = options.status
    }

    return options
  },

  /**
    * Returns an array of keys permitted in a method's `options` hash, depending on the current method.
    * @param {String} methodName The name of the method to check valid options for.
    * @return {Array} Keys allowed in the `options` hash of the model's method.
    */
  permittedOptions: function permittedOptions (methodName) {
    let options = ghostBookshelf.Model.permittedOptions()

    // whitelists for the `options` hash argument on methods, by method name.
    // these are the only options that can be passed to Bookshelf / Knex.
    const validOptions = {
      findOne: ['withRelated', 'status'],
      findAll: ['withRelated'],
      setup: ['id'],
      edit: ['withRelated', 'id'],
      findPage: ['page', 'limit', 'status']
    }

    if (validOptions[methodName]) {
      options = options.concat(validOptions[methodName])
    }

    return options
  },

  /**
     * ### Find All
     *
     * @param {Object} options
     * @returns {*}
     */
  findAll: function findAll (options) {
    options = options || {}
    options.withRelated = _.union(options.withRelated, options.include)
    return ghostBookshelf.Model.findAll.call(this, options)
  },

  /**
     * ### Find One
     * @extends ghostBookshelf.Model.findOne to include roles
     * **See:** [ghostBookshelf.Model.findOne](base.js.html#Find%20One)
     */
  findOne: function findOne (data, options) {
    let query
    let status
    const lookupRole = data.role

    delete data.role

    data = _.defaults(data || {}, {
      status: 'active'
    })

    status = data.status
    delete data.status

    options = options || {}
    options.withRelated = _.union(options.withRelated, options.include)
    data = this.filterData(data)

    // Support finding by role
    if (lookupRole) {
      options.withRelated = _.union(options.withRelated, ['roles'])
      options.include = _.union(options.include, ['roles'])

      query = this.forge(data, { include: options.include })

      query.query('join', 'roles_users', 'users.id', '=', 'roles_users.id')
      query.query('join', 'roles', 'roles_users.role_id', '=', 'roles.id')
      query.query('where', 'roles.name', '=', lookupRole)
    } else {
      // We pass include to forge so that toJSON has access
      query = this.forge(data, { include: options.include })
    }

    if (status === 'active') {
      query.query('whereIn', 'status', activeStates)
    } else if (status === 'invited') {
      query.query('whereIn', 'status', invitedStates)
    } else if (status !== 'all') {
      query.query('where', { status: options.status })
    }

    options = this.filterOptions(options, 'findOne')
    delete options.include

    return query.fetch(options)
  },

  /**
     * ### Edit
     * @extends ghostBookshelf.Model.edit to handle returning the full object
     * **See:** [ghostBookshelf.Model.edit](base.js.html#edit)
     */
  edit: function edit (data, options) {
    const self = this
    let roleId

    if (data.roles && data.roles.length > 1) {
      return Promise.reject(
        new errors.ValidationError('Only one role per user is supported at the moment.')
      )
    }

    options = options || {}
    options.withRelated = _.union(options.withRelated, options.include)

    return ghostBookshelf.Model.edit.call(this, data, options).then(function then (user) {
      if (!data.roles) {
        return user
      }

      roleId = parseInt(data.roles[0].id || data.roles[0], 10)

      return user.roles().fetch().then(function then (roles) {
        // return if the role is already assigned
        if (roles.models[0].id === roleId) {
          return
        }
        return ghostBookshelf.model('Role').findOne({ id: roleId })
      }).then(function then (roleToAssign) {
        if (roleToAssign && roleToAssign.get('name') === 'Owner') {
          return Promise.reject(
            new errors.ValidationError('This method does not support assigning the owner role')
          )
        } else {
          // assign all other roles
          return user.roles().updatePivot({ role_id: roleId })
        }
      }).then(function then () {
        options.status = 'all'
        return self.findOne({ id: user.id }, options)
      })
    })
  },

  /**
     * ## Add
     * Naive user add
     * Hashes the password provided before saving to the database.
     *
     * @param {object} data
     * @param {object} options
     * @extends ghostBookshelf.Model.add to manage all aspects of user signup
     * **See:** [ghostBookshelf.Model.add](base.js.html#Add)
     */
  add: function add (data, options) {
    const self = this
    let userData = this.filterData(data)
    let roles

    options = this.filterOptions(options, 'add')
    options.withRelated = _.union(options.withRelated, options.include)

    // check for too many roles
    if (data.roles && data.roles.length > 1) {
      return Promise.reject(new errors.ValidationError('Only one role per user is supported at the moment.'))
    }

    if (!validatePasswordLength(userData.password)) {
      return Promise.reject(new errors.ValidationError('Your password must be at least 8 characters long.'))
    }

    function getAuthorRole () {
      return ghostBookshelf.model('Role').findOne({ name: 'Author' }, _.pick(options, 'transacting')).then(function then (authorRole) {
        return [authorRole.get('id')]
      })
    }

    roles = data.roles || getAuthorRole()
    delete data.roles

    return generatePasswordHash(userData.password).then(function then (results) {
      // Assign the hashed password
      userData.password = results[1]
      // LookupGravatar
      return self.gravatarLookup(userData)
    }).then(function then (userData) {
      // Save the user with the hashed password
      return ghostBookshelf.Model.add.call(self, userData, options)
    }).then(function then (addedUser) {
      // Assign the userData to our created user so we can pass it back
      userData = addedUser
      // if we are given a "role" object, only pass in the role ID in place of the full object
      return Promise.resolve(roles).then(function then (roles) {
        roles = _.map(roles, function mapper (role) {
          if (_.isString(role)) {
            return parseInt(role, 10)
          } else if (_.isNumber(role)) {
            return role
          } else {
            return parseInt(role.id, 10)
          }
        })

        return addedUser.roles().attach(roles, options)
      })
    }).then(function then () {
      // find and return the added user
      return self.findOne({ id: userData.id, status: 'all' }, options)
    })
  },

  setup: function setup (data, options) {
    const self = this
    let userData = this.filterData(data)

    if (!validatePasswordLength(userData.password)) {
      return Promise.reject(new errors.ValidationError('Your password must be at least 8 characters long.'))
    }

    options = this.filterOptions(options, 'setup')
    options.withRelated = _.union(options.withRelated, options.include)
    options.shortSlug = true

    return generatePasswordHash(data.password).then(function then (hash) {
      // Assign the hashed password
      userData.password = hash

      return Promise.join(self.gravatarLookup(userData),
        ghostBookshelf.Model.generateSlug.call(this, User, userData.name, options))
    }).then(function then (results) {
      userData = results[0]
      userData.slug = results[1]

      return self.edit.call(self, userData, options)
    })
  },

  permissible: function permissible (userModelOrId, action, context, loadedPermissions, hasUserPermission, hasAppPermission) {
    const self = this
    const userModel = userModelOrId
    let origArgs

    // If we passed in a model without its related roles, we need to fetch it again
    if (_.isObject(userModelOrId) && !_.isObject(userModelOrId.related('roles'))) {
      userModelOrId = userModelOrId.id
    }
    // If we passed in an id instead of a model get the model first
    if (_.isNumber(userModelOrId) || _.isString(userModelOrId)) {
      // Grab the original args without the first one
      origArgs = _.toArray(arguments).slice(1)
      // Get the actual post model
      return this.findOne({ id: userModelOrId, status: 'all' }, { include: ['roles'] }).then(function then (foundUserModel) {
        // Build up the original args but substitute with actual model
        const newArgs = [foundUserModel].concat(origArgs)

        return self.permissible.apply(self, newArgs)
      }, errors.logAndThrowError)
    }

    if (action === 'edit') {
      // Owner can only be editted by owner
      if (userModel.hasRole('Owner')) {
        hasUserPermission = _.any(loadedPermissions.user.roles, { name: 'Owner' })
      }
      // Users with the role 'Editor' and 'Author' have complex permissions when the action === 'edit'
      // We now have all the info we need to construct the permissions
      if (_.any(loadedPermissions.user.roles, { name: 'Author' })) {
        // If this is the same user that requests the operation allow it.
        hasUserPermission = hasUserPermission || context.user === userModel.get('id')
      }

      if (_.any(loadedPermissions.user.roles, { name: 'Editor' })) {
        // If this is the same user that requests the operation allow it.
        hasUserPermission = context.user === userModel.get('id')

        // Alternatively, if the user we are trying to edit is an Author, allow it
        hasUserPermission = hasUserPermission || userModel.hasRole('Author')
      }
    }

    if (action === 'destroy') {
      // Owner cannot be deleted EVER
      if (userModel.hasRole('Owner')) {
        return Promise.reject()
      }

      // Users with the role 'Editor' have complex permissions when the action === 'destroy'
      if (_.any(loadedPermissions.user.roles, { name: 'Editor' })) {
        // If this is the same user that requests the operation allow it.
        hasUserPermission = context.user === userModel.get('id')

        // Alternatively, if the user we are trying to edit is an Author, allow it
        hasUserPermission = hasUserPermission || userModel.hasRole('Author')
      }
    }

    if (hasUserPermission && hasAppPermission) {
      return Promise.resolve()
    }

    return Promise.reject()
  },

  setWarning: function setWarning (user, options) {
    const status = user.get('status')
    const regexp = /warn-(\d+)/i
    let level

    if (status === 'active') {
      user.set('status', 'warn-1')
      level = 1
    } else {
      level = parseInt(status.match(regexp)[1], 10) + 1
      if (level > 4) {
        user.set('status', 'locked')
      } else {
        user.set('status', 'warn-' + level)
      }
    }
    return Promise.resolve(user.save(options)).then(function then () {
      return 5 - level
    })
  },

  // Finds the user by email, and checks the password
  check: function check (object) {
    const self = this
    let s
    return this.getByEmail(object.email).then(function then (user) {
      if (!user) {
        return Promise.reject(new errors.NotFoundError('There is no user with that email address.'))
      }
      if (user.get('status') === 'invited' || user.get('status') === 'invited-pending' ||
                    user.get('status') === 'inactive'
      ) {
        return Promise.reject(new Error('The user with that email address is inactive.'))
      }
      if (user.get('status') !== 'locked') {
        return bcryptCompare(object.password, user.get('password')).then(function then (matched) {
          if (!matched) {
            return Promise.resolve(self.setWarning(user, { validate: false })).then(function then (remaining) {
              s = (remaining > 1) ? 's' : ''
              return Promise.reject(new errors.UnauthorizedError('Your password is incorrect. <br />' +
                                remaining + ' attempt' + s + ' remaining!'))

              // Use comma structure, not .catch, because we don't want to catch incorrect passwords
            }, function handleError (error) {
              // If we get a validation or other error during this save, catch it and log it, but don't
              // cause a login error because of it. The user validation is not important here.
              errors.logError(
                error,
                'Error thrown from user update during login',
                'Visit and save your profile after logging in to check for problems.'
              )
              return Promise.reject(new errors.UnauthorizedError('Your password is incorrect.'))
            })
          }

          return Promise.resolve(user.set({ status: 'active', last_login: new Date() }).save({ validate: false }))
            .catch(function handleError (error) {
              // If we get a validation or other error during this save, catch it and log it, but don't
              // cause a login error because of it. The user validation is not important here.
              errors.logError(
                error,
                'Error thrown from user update during login',
                'Visit and save your profile after logging in to check for problems.'
              )
              return user
            })
        }, errors.logAndThrowError)
      }
      return Promise.reject(new errors.NoPermissionError('Your account is locked. Please reset your password ' +
                'to log in again by clicking the "Forgotten password?" link!'))
    }, function handleError (error) {
      if (error.message === 'NotFound' || error.message === 'EmptyResponse') {
        return Promise.reject(new errors.NotFoundError('There is no user with that email address.'))
      }

      return Promise.reject(error)
    })
  },

  /**
     * Naive change password method
     * @param {Object} object
     * @param {Object} options
     */
  changePassword: function changePassword (object, options) {
    const self = this
    const newPassword = object.newPassword
    const ne2Password = object.ne2Password
    const userId = object.user_id
    const oldPassword = object.oldPassword
    let user

    if (newPassword !== ne2Password) {
      return Promise.reject(new errors.ValidationError('Your new passwords do not match'))
    }

    if (userId === options.context.user && _.isEmpty(oldPassword)) {
      return Promise.reject(new errors.ValidationError('Password is required for this operation'))
    }

    if (!validatePasswordLength(newPassword)) {
      return Promise.reject(new errors.ValidationError('Your password must be at least 8 characters long.'))
    }

    return self.forge({ id: userId }).fetch({ require: true }).then(function then (_user) {
      user = _user
      if (userId === options.context.user) {
        return bcryptCompare(oldPassword, user.get('password'))
      }
      // if user is admin, password isn't compared
      return true
    }).then(function then (matched) {
      if (!matched) {
        return Promise.reject(new errors.ValidationError('Your password is incorrect'))
      }

      return generatePasswordHash(newPassword)
    }).then(function then (hash) {
      return user.save({ password: hash })
    })
  },

  generateResetToken: function generateResetToken (email, expires, dbHash) {
    return this.getByEmail(email).then(function then (foundUser) {
      if (!foundUser) {
        return Promise.reject(new errors.NotFoundError('There is no user with that email address.'))
      }

      const hash = crypto.createHash('sha256')
      let text = ''

      // Token:
      // BASE64(TIMESTAMP + email + HASH(TIMESTAMP + email + oldPasswordHash + dbHash ))
      hash.update(String(expires))
      hash.update(email.toLocaleLowerCase())
      hash.update(foundUser.get('password'))
      hash.update(String(dbHash))

      text += [expires, email, hash.digest('base64')].join('|')
      return new Buffer(text).toString('base64')
    })
  },

  validateToken: function validateToken (token, dbHash) {
    /* jslint bitwise:true */
    // TODO: Is there a chance the use of ascii here will cause problems if oldPassword has weird characters?
    const tokenText = new Buffer(token, 'base64').toString('ascii')
    let parts
    let expires
    let email

    parts = tokenText.split('|')

    // Check if invalid structure
    if (!parts || parts.length !== 3) {
      return Promise.reject(new Error('Invalid token structure'))
    }

    expires = parseInt(parts[0], 10)
    email = parts[1]

    if (isNaN(expires)) {
      return Promise.reject(new Error('Invalid token expiration'))
    }

    // Check if token is expired to prevent replay attacks
    if (expires < Date.now()) {
      return Promise.reject(new Error('Expired token'))
    }

    // to prevent brute force attempts to reset the password the combination of email+expires is only allowed for
    // 10 attempts
    if (tokenSecurity[email + '+' + expires] && tokenSecurity[email + '+' + expires].count >= 10) {
      return Promise.reject(new Error('Token locked'))
    }

    return this.generateResetToken(email, expires, dbHash).then(function then (generatedToken) {
      // Check for matching tokens with timing independent comparison
      let diff = 0
      let i

      // check if the token length is correct
      if (token.length !== generatedToken.length) {
        diff = 1
      }

      for (i = token.length - 1; i >= 0; i = i - 1) {
        diff |= token.charCodeAt(i) ^ generatedToken.charCodeAt(i)
      }

      if (diff === 0) {
        return email
      }

      // increase the count for email+expires for each failed attempt
      tokenSecurity[email + '+' + expires] = {
        count: tokenSecurity[email + '+' + expires] ? tokenSecurity[email + '+' + expires].count + 1 : 1
      }
      return Promise.reject(new Error('Invalid token'))
    })
  },

  resetPassword: function resetPassword (options) {
    const self = this
    const token = options.token
    const newPassword = options.newPassword
    const ne2Password = options.ne2Password
    const dbHash = options.dbHash

    if (newPassword !== ne2Password) {
      return Promise.reject(new Error('Your new passwords do not match'))
    }

    if (!validatePasswordLength(newPassword)) {
      return Promise.reject(new errors.ValidationError('Your password must be at least 8 characters long.'))
    }

    // Validate the token; returns the email address from token
    return self.validateToken(utils.decodeBase64URLsafe(token), dbHash).then(function then (email) {
      // Fetch the user by email, and hash the password at the same time.
      return Promise.join(
        self.getByEmail(email),
        generatePasswordHash(newPassword)
      )
    }).then(function then (results) {
      if (!results[0]) {
        return Promise.reject(new Error('User not found'))
      }

      // Update the user with the new password hash
      const foundUser = results[0]
      const passwordHash = results[1]

      return foundUser.save({ password: passwordHash, status: 'active' })
    })
  },

  transferOwnership: function transferOwnership (object, options) {
    let ownerRole,
      contextUser

    return Promise.join(ghostBookshelf.model('Role').findOne({ name: 'Owner' }),
      User.findOne({ id: options.context.user }, { include: ['roles'] }))
      .then(function then (results) {
        ownerRole = results[0]
        contextUser = results[1]

        // check if user has the owner role
        const currentRoles = contextUser.toJSON(options).roles
        if (!_.any(currentRoles, { id: ownerRole.id })) {
          return Promise.reject(new errors.NoPermissionError('Only owners are able to transfer the owner role.'))
        }

        return Promise.join(ghostBookshelf.model('Role').findOne({ name: 'Administrator' }),
          User.findOne({ id: object.id }, { include: ['roles'] }))
      }).then(function then (results) {
        const adminRole = results[0]
        const user = results[1]
        const currentRoles = user.toJSON(options).roles

        if (!_.any(currentRoles, { id: adminRole.id })) {
          return Promise.reject(new errors.ValidationError('Only administrators can be assigned the owner role.'))
        }

        // convert owner to admin
        return Promise.join(contextUser.roles().updatePivot({ role_id: adminRole.id }),
          user.roles().updatePivot({ role_id: ownerRole.id }),
          user.id)
      }).then(function then (results) {
        return Users.forge()
          .query('whereIn', 'id', [contextUser.id, results[2]])
          .fetch({ withRelated: ['roles'] })
      }).then(function then (users) {
        options.include = ['roles']
        return users.toJSON(options)
      })
  },

  gravatarLookup: function gravatarLookup (userData) {
    let gravatarUrl = '//www.gravatar.com/avatar/' +
                crypto.createHash('sha256').update(userData.email.toLowerCase().trim()).digest('hex') +
                '?s=250'

    return new Promise(function gravatarRequest (resolve) {
      if (config.isPrivacyDisabled('useGravatar')) {
        return resolve(userData)
      }

      request({ url: 'http:' + gravatarUrl + '&d=404&r=x', timeout: 2000 }, function handler (err, response) {
        if (err) {
          // just resolve with no image url
          return resolve(userData)
        }

        if (response.statusCode !== 404) {
          gravatarUrl += '&d=mm&r=x'
          userData.image = gravatarUrl
        }

        resolve(userData)
      })
    })
  },
  // Get the user by email address, enforces case insensitivity rejects if the user is not found
  // When multi-user support is added, email addresses must be deduplicated with case insensitivity, so that
  // joe@bloggs.com and JOE@BLOGGS.COM cannot be created as two separate users.
  getByEmail: function getByEmail (email, options) {
    options = options || {}
    // We fetch all users and process them in JS as there is no easy way to make this query across all DBs
    // Although they all support `lower()`, sqlite can't case transform unicode characters
    // This is somewhat mute, as validator.isEmail() also doesn't support unicode, but this is much easier / more
    // likely to be fixed in the near future.
    options.require = true

    return Users.forge(options).fetch(options).then(function then (users) {
      const userWithEmail = users.find(function findUser (user) {
        return user.get('email').toLowerCase() === email.toLowerCase()
      })
      if (userWithEmail) {
        return userWithEmail
      }
    })
  }
})

Users = ghostBookshelf.Collection.extend({
  model: User
})

module.exports = {
  User: ghostBookshelf.model('User', User),
  Users: ghostBookshelf.collection('Users', Users)
}
