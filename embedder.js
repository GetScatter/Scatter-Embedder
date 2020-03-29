const yauzl = require("yauzl");

let CLIENT_VERSION, REPO, PROOF_KEYS, NOTIFIER, PROMPTER, FILES, LOCAL_TESTING, SIGNATURE_CHECKER, SHA256, PROGRESS_EVENT, IS_STAGING;
let ETAGS = {};

const FILE_SERVICE_FNS = ['getFilesForDirectory', 'getDefaultPath', 'saveFile', 'openFile', 'existsOrMkdir', 'exists'];

const MAX_TRIES = 5;

const ERR_TITLE = 'Scatter Check Failure';
const API_ERR = `Scatter failed to make a connection with our API which is used to verify the hash of the web wallet embed. If you are in a country which restricts IPs such as China or Russia, you may need to enable a proxy.`
const HASH_ERR = `The hash created from the web wallet embed does not match the hash returned from our secure API. This could be due to an update happening right now. Please try again in a moment. If this problem persists please contact support immediately at support@get-scatter.com, or on Telegram on the @Scatter channel, or Twitter at @Get_Scatter.`


const saveSource = async (filename, file) => {
	const sourcePath = `${await FILES.getDefaultPath()}/cached_sources`;
	await FILES.existsOrMkdir(sourcePath);
	return FILES.saveFile(sourcePath, filename, file);
};


const checkSignature = async (hashed, signed) => {
	const recovered = await SIGNATURE_CHECKER(hashed, signed);
	let proven = false;
	for(let i = 0; i < PROOF_KEYS.length; i++){
		try {
			if(recovered === PROOF_KEYS[i]) {
				proven = true;
				break;
			}
		} catch(e){}
	}
	return proven;
}

const filterFiles = x => (x.indexOf('.js') > -1 || x.indexOf('.html') > -1 || x.indexOf('.css') > -1) && x.indexOf('.etags') === -1 && x.indexOf('.version') === -1;

const sendProgress = (msg) => {
	if(PROGRESS_EVENT) PROGRESS_EVENT(msg);
	else console.log('PROGRESS_EVENT', msg);
};




const getReleaseInfo = async (lastModified) => {
	// If fetching from host fails, trying to fetch directly from github releases.
	return fetch(`https://api.github.com/repos/GetScatter/${REPO}/releases/latest`, {
		headers:{ "If-Modified-Since":lastModified }
	}).then(async x => {
		if(x.status === 304) return {notModified:true};
		if(x.status !== 200) return null;
		return {
			newLastModified:x.headers.get('last-modified'),
			json:await x.json(),
			notModified:false,
		}
	}).catch(() => null);
}


class Embedder {

	static init(
		clientVersion,
		repo = 'Bridge',
		proofKeys,
		fileService,
		sha256er,
		notifier = (title, text) => console.log('Notifier: ', title, text),
		prompter = (title, text) => console.log('Prompt: ', title, text),
		signatureChecker = (hashed, signed) => console.log('Signature Checker: ', hashed, signed),
		progressEvent = null,
		localTesting = false,
		staging = false,
	) {
		IS_STAGING = staging;
		CLIENT_VERSION = clientVersion;
		REPO = repo;
		PROOF_KEYS = proofKeys;
		FILES = fileService;
		SHA256 = sha256er;
		NOTIFIER = notifier;
		PROMPTER = prompter;
		SIGNATURE_CHECKER = signatureChecker;

		// Optionals
		PROGRESS_EVENT = progressEvent;
		LOCAL_TESTING = localTesting;

		if(!PROOF_KEYS.length) throw new Error('You must include Proofing Keys');
		if(!FILE_SERVICE_FNS.every(prop => typeof FILES[prop] === 'function')) throw new Error(`fileService must have the following methods: ${FILE_SERVICE_FNS}`);
		if(!SHA256 || typeof SHA256 !== 'function') throw new Error('Sha256 must be a function.');
	}

	// Removes old files.
	static async removeOldFiles(){
		const localFiles = await FILES.getFilesForDirectory(`${await FILES.getDefaultPath()}/cached_sources`).catch(() => []);
		await Promise.all(localFiles.map(async filename => {
			return FILES.removeFile(`${await FILES.getDefaultPath()}/cached_sources/${filename}`);
		}));
	}

	// Checks if the user has a timestamp file locally at all,
	// which is always the last file that is cached.
	static async hasLocalVersion(){
		if(LOCAL_TESTING) return false;
		return FILES.openFile(`${await FILES.getDefaultPath()}/cached_sources/release.tag`).then(x => !!x).catch(() => null)
	}

	static async lastModified(){
		if(LOCAL_TESTING) return false;
		return FILES.openFile(`${await FILES.getDefaultPath()}/cached_sources/modified.tag`).catch(() => null)
	}

	static async getZip(info){

		return new Promise(async (resolve, reject) => {
			sendProgress('Downloading new version...');
			const downloadUrl = info.assets.find(x => x.name.indexOf('.zip') > -1).browser_download_url;
			const [repoTag, tagName, signature, ext] = downloadUrl.split('/')[downloadUrl.split('/').length-1].split('.');
			const buf = await fetch(downloadUrl, { headers:{ 'Content-type':'application/zip' } })
				.then(x => x.buffer()).catch(err => console.error(err));
			if(!buf) return resolve(null);

			const hash = SHA256(buf);
			if(!await checkSignature(hash, signature)) {
				NOTIFIER(ERR_TITLE, HASH_ERR);
				return resolve(null);
			}

			sendProgress('Finished downloading new version!');
			return resolve(buf);
		})
	}

	static async unzip(buf){
		return new Promise(async (resolve, reject) => {
			yauzl.fromBuffer(buf, {lazyEntries:true}, (err, zipfile) => {
				if (err) return resolve(console.error(err));
				zipfile.readEntry();
				zipfile.on("entry", (entry) => {
					try {
						// DIR
						if (/\/$/.test(entry.fileName)) zipfile.readEntry();
						// FILE
						else zipfile.openReadStream(entry, (err, stream) => {
							if (err) return resolve(console.error(err));
							let filedata = '';
							stream.on('data',data => filedata += data.toString());
							stream.on("end", async () => {
								await saveSource(entry.fileName, filedata);
								sendProgress(`Unpacking version file ${zipfile.entriesRead} of ${zipfile.entryCount}`);
								if(zipfile.entriesRead === zipfile.entryCount) return resolve(true);
								else zipfile.readEntry();
							});
						});
					} catch(e){
						console.error(e);
					}
				});
			});
		})
	}

	static async loadManualZipFile(zipBuffer, signature, releaseTag){
		if(!zipBuffer) return false;
		sendProgress('Checking zip file.');

		const hash = SHA256(zipBuffer);
		if(!await checkSignature(hash, signature)) {
			NOTIFIER(ERR_TITLE, HASH_ERR);
			return false;
		}


		sendProgress('Loading zip file.');

		await Embedder.removeOldFiles();
		await Embedder.unzip(zipBuffer);
		await saveSource('release.tag', releaseTag);

		const date = new Date();
		const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const hour = date.getUTCHours(),
			minute = date.getUTCMinutes(),
			second = date.getUTCSeconds(),
			hourFormatted = hour < 12 ? "0" + hour % 12 || 12 : hour % 12 || 12,
			minuteFormatted = minute < 10 ? "0" + minute : minute,
			morning = hour < 12 ? "am" : "pm";

		// Just faking a last modification header.
		const lastModified = `${DAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ${hourFormatted}:${minuteFormatted}:${second} GMT`;
		await saveSource('modified.tag', lastModified);
		sendProgress('Zip file loaded successfully!');
		return true;
	}

	static async check(){
		let hasEmbed = false;

		const hasLocalVersion = await Embedder.hasLocalVersion();

		sendProgress('Checking for new versions.');
		const lastModified = hasLocalVersion ? await Embedder.lastModified() : null;
		const releaseInfo = await getReleaseInfo(lastModified);
		if(!releaseInfo){
			NOTIFIER(ERR_TITLE, API_ERR);
			return false;
		}

		const {json:latestRelease, newLastModified, notModified} = releaseInfo;
		if(notModified && hasLocalVersion) return true;

		const updateLocalFiles = async () => {
			const zipBuffer = await Embedder.getZip(latestRelease);

			if(!zipBuffer){
				hasEmbed = await PROMPTER(
					'There was an issue getting the latest embed version.',
					'Would you like to keep using your locally cached version of Scatter which has already been verified previously?'
				);
			} else {
				await Embedder.removeOldFiles();
				await Embedder.unzip(zipBuffer);
				await saveSource('release.tag', latestRelease.tag_name);
				await saveSource('modified.tag', newLastModified);
				hasEmbed = true;
			}
		};

		const versionAvailable = async () => {
			if(LOCAL_TESTING) return true;

			const localReleaseTag = await FILES.openFile(`${await FILES.getDefaultPath()}/cached_sources/release.tag`).catch(() => null);
			return latestRelease.tag_name.trim() !== localReleaseTag.trim();
		};

		if(!hasLocalVersion) await updateLocalFiles();

		else {
			if (await versionAvailable()) {
				if (await PROMPTER(
					'An updated Scatter is available.',
					'There is an updated version of Scatter available. Do you want to update automatically?'
				)) await updateLocalFiles();
				else hasEmbed = true;
			} else hasEmbed = true;
		}

		return hasEmbed;
	}

}

module.exports = Embedder;
