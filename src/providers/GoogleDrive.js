import Logger from 'util/Logger';
import StorageProvider from 'providers/StorageProvider';
import * as _ from 'lodash';


var logger = new Logger('[GoogleDrive.js]');

export default class GoogleDrive extends StorageProvider {
  constructor() {
    super();
    
    this.accessToken = null;
    this.refreshToken = null;
  }

  getType() {
    return 'googledrive';
  }
  getCredentials() {
    return this.accessToken ? { accessToken: this.accessToken, refreshToken: this.refreshToken } : null;
  }
  isAuthed() {
    return this.accessToken ? true : false;  
  }
  authorize(credentials) {
    this.accessToken = credentials.accessToken;
    this.refreshToken = credentials.refreshToken;

    return this.checkRefreshToken()
      .catch((err) => {
        // Special error handling can go here
        throw err;
      });
  }
  deauthorize() {
    return this.checkRefreshToken()
      .then(() => {
        // Notes:
        // Revoke will remove access to the entire app for Google. We cannot call this endpoint without breaking other instances of this extension
        // The access token will just expire on its own over time and without the refresh token in memory can never be revived
        /*
        fetch('https://accounts.google.com/o/oauth2/revoke', {
          method: 'POST',
          body: new URLSearchParams({
            token: this.accessToken
          }),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          }
        });
        */
      })
      .then(() => {
        this.accessToken = null;
        this.refreshToken = null;
      });
  }
  checkRefreshToken() {
    logger.log('Verifying access token...');

    return fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + this.accessToken)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .catch((error) => {
        // Handle specific case of an invalid token
        if (error.message.includes("400")) {
          logger.log('Access token expired. Attempting to fetch new token...');
          
          // Token invalid, get new refresh token
          const url = PRODUCTION ? 'https://syncmarx.com/auth/googledrive/refreshtoken' : 'http://localhost:1800/auth/googledrive/refreshtoken';
          const params = new URLSearchParams({ refresh_token: this.refreshToken });

          return fetch(`${url}?${params}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            }
          })
          .then(response => response.json())
          .then(data => {
            this.accessToken = data.access_token;

            logger.log('Obtained new token!');

            return data;
          });
        } else {
          logger.error('Problem checking token', error);
          // Pass error along
          throw error;
        }
      })
      .then((data) => {
        if (data) {
          logger.log('Token info:', data);
        } else {
          throw new Error('No response from provider');
        }
      });
  }
  getOrCreateAppFolder() {
    // Make sure a folder exists on the drive to place data
    return this.checkRefreshToken()
      .then(() => {
        return fetch('https://www.googleapis.com/drive/v3/files?includeItemsFromAllDrives=true&supportsAllDrives=true', {
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + this.accessToken }
        })
        .then(response => response.json())
        .then(data => {
          logger.log(data.files);

          let fullFileList = data.files;

          // Extract folders from list
          let appFolder = fullFileList.find(file => file.mimeType === 'application/vnd.google-apps.folder' && file.name === 'syncmarx');

          if (appFolder) {
            logger.log('App folder found:', appFolder);
            return appFolder;
          } else {
            logger.log('App folder not found, creating new one...');

            return fetch('https://www.googleapis.com/drive/v3/files', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + this.accessToken },
              body: JSON.stringify({
                name: 'syncmarx',
                mimeType: 'application/vnd.google-apps.folder'
              })
            })
            .then(response => response.json())
            .then(data => {
              logger.log('App folder created: ', data);

              return data;
            });
          }
        });
      });
  }
  filesList() {
    return this.checkRefreshToken()
      .then(() => {
        return this.getOrCreateAppFolder();
      })
      .then(() => {
        return fetch('https://www.googleapis.com/drive/v3/files', {
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + this.accessToken }
        })
      })
      .then(response => response.json())
      .then(data => {
        logger.log(data.files);

        // Extract files from list
        let filesFound = _.filter(data.files, (file) => {
          return file.mimeType !== 'application/vnd.google-apps.folder';
        });

        // Return the files in usable format
        return _.map(filesFound, (file) => {
          return {
            id: file.id,
            name: file.name.replace(/\.(.*?)$/g, '')
          };
        });
      });
  }
  fileUpload(data) {
    var file = null;
    let appFolder = null;

    return this.checkRefreshToken()
      .then(() => {
        return this.getOrCreateAppFolder();
      })
      .then((folder) => {
        appFolder = folder;

        // Get existing file list first
        return this.filesList();
      })
      .then((files) => {
        // See if a file exists with this file name already
        var existingFile = null;
        
        if (!data.id && !data.fileName) {
          throw new Error('Error, profile id and file name were not specified');
        } else {
          // Find by id or name
          existingFile = _.find(files, (f) => f.id === data.id || f.name === data.fileName);
        }

        // Encrypt and compress
        var encryptedData = (data.compression) ? this.encryptData(data.contents) : JSON.stringify(data.contents, null, 2);
        file = new Blob([encryptedData], {"type": "text/plain"});

        // Choose appropriate method and URL based on create versus update
        let method = existingFile ? 'PATCH' : 'POST';
        let url = 'https://www.googleapis.com/upload/drive/v3/files';

        if (existingFile) {
          url += `/${existingFile.id}`;
        }

        let metadata = {
          name: (existingFile) ? existingFile.name : data.fileName,
          mimeType: 'text/plain'      
        };

        if (!existingFile) {
          metadata.parents = [appFolder.id];    
        }

        // Intitiate the upload
        return fetch(`${url}?uploadType=resumable`, {
          method: method,
          body: JSON.stringify(metadata),
          headers: {
            'Authorization': 'Bearer ' + this.accessToken,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': file.size.toString(),
            'X-Upload-Content-Type': 'text/plain'
          }
        });
      })
      .then(response => {
        logger.info(response);

        // Upload the file
        return fetch(response.headers.get('Location'), {
          method: 'PUT',
          body: file,
          headers: {
            'Authorization': 'Bearer ' + this.accessToken
          }
        });
      })
      .then(response => response.json())
      .then((response) => {
        logger.info(response);
      });
  }
  fileDownload(data) {
    return this.checkRefreshToken()
      .then(() => {
        // Get existing file list first
        return this.filesList();
      })
      .then((files) => {
        // See if a file exists with this file name already
        let existingFile = _.find(files, (f) => f.id === data.id);
        
        // Intitiate the download
        return fetch(`https://www.googleapis.com/drive/v3/files/${existingFile.id}?alt=media`, {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer ' + this.accessToken
          }
        });
      })
      .then(response => response.text())
      .then(data => {
        logger.log('File downloaded!', data);
      
        // Decompress and decrypt
        var contents = null;
        var compressed = false;
      
        try {
          contents = JSON.parse(data);
        } catch(e) {
          contents = this.decryptData(data);
          compressed = true;
        }
      
        return { contents: contents, compressed: compressed };
      });
  }
}